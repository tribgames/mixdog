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
    // A warm builds nothing for a tree no query has measured: the foreground call fills the cache.
    cache.graph(&root, &[]).unwrap();
    assert!(tool.prewarm_if_project(&root.join("src"), tokens.maintenance_io, &cancel).await);
    assert_eq!(cache.builds(), 1);
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
    let symbol_of = |graph: &super::graph::Graph| graph.node("src/a.mjs").unwrap().symbols[0].name.clone();
    let first = super::graph::Graph::build(&root, &[], &cache).unwrap();
    assert_eq!(symbol_of(&first), "a");
    cache.flush().unwrap();
    // Alter the cached copy in place: a build that answers with it has reused the entry.
    let payload = fs::read_dir(cache_dir.path().join("cache"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_name().unwrap() != "manifest.json")
        .unwrap();
    let stored = fs::read_to_string(&payload).unwrap();
    assert!(stored.contains(r#""name":"a""#), "{stored}");
    assert!(!stored.contains("export const a"), "the payload holds no source text: {stored}");
    fs::write(&payload, stored.replace(r#""name":"a""#, r#""name":"zz""#)).unwrap();
    let reused = super::graph::Graph::build(&root, &[], &cache).unwrap();
    assert_eq!(symbol_of(&reused), "zz", "an unchanged file comes from the cache");
    // A changed file (new size) is read and parsed again.
    fs::write(root.join("src/a.mjs"), "export const a = 123;\n").unwrap();
    let reparsed = super::graph::Graph::build(&root, &[], &cache).unwrap();
    assert_eq!(symbol_of(&reparsed), "a");
    assert_eq!(reparsed.node("src/a.mjs").unwrap().read().text(), "export const a = 123;\n");
    assert_eq!(reparsed.node("src/b.mjs").unwrap().resolved_imports, vec!["src/a.mjs".to_owned()]);
}

#[test]
fn a_valid_held_graph_is_reused_without_a_rebuild() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let first = cache.graph(&root, &[]).unwrap();
    let second = cache.graph(&root, &[]).unwrap();
    assert_eq!(cache.builds(), 1);
    assert!(std::sync::Arc::ptr_eq(&first.graph, &second.graph));
}

#[test]
fn a_changed_file_invalidates_the_held_graph() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let first = cache.graph(&root, &[]).unwrap();
    fs::write(root.join("src/a.mjs"), "export const a = 123456;\n").unwrap();
    let second = cache.graph(&root, &[]).unwrap();
    assert_eq!(cache.builds(), 2);
    assert_eq!(second.node("src/a.mjs").unwrap().read().text(), "export const a = 123456;\n");
    // A graph read after its file changed fails safe: the read is empty and the graph says it is stale.
    assert!(!first.source_stale());
    assert_eq!(first.node("src/a.mjs").unwrap().read().text(), "");
    assert!(first.source_stale());
    assert_eq!(cache.held_roots().len(), 1, "the stale graph left the cache");
}

#[test]
fn concurrent_callers_of_one_root_share_one_build() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let graphs: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4).map(|_| scope.spawn(|| cache.graph(&root, &[]).unwrap())).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(cache.builds(), 1);
    assert!(graphs.iter().all(|g| std::sync::Arc::ptr_eq(&g.graph, &graphs[0].graph)));
}

/// Callers of one root wait for the build under way and share its graph even when the cache could not keep it.
#[test]
fn concurrent_callers_share_the_build_of_a_graph_that_is_not_held() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = cache.with_graph_budget(6, 1);
    let permit = cache.hold_gate();
    let graphs: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..3).map(|_| scope.spawn(|| cache.graph(&root, &[]).unwrap())).collect();
        // Every caller is queued behind the gate (one as the builder, the rest waiting on it) before it opens.
        std::thread::sleep(std::time::Duration::from_millis(400));
        drop(permit);
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(cache.builds(), 1);
    assert!(graphs.iter().all(|g| std::sync::Arc::ptr_eq(&g.graph, &graphs[0].graph)));
}

/// A graph the cache does not hold keeps the gate while its call uses it: no second graph is built meanwhile.
#[test]
fn an_unheld_graph_blocks_the_next_build_until_its_call_is_done() {
    let (_t1, one) = project_with_sentinel();
    let (_t2, two) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = cache.with_graph_budget(6, 1);
    let first = cache.graph(&one, &[]).unwrap();
    std::thread::scope(|scope| {
        let next = scope.spawn(|| cache.graph(&two, &[]).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert_eq!(cache.builds(), 1, "the second build waits for the first graph's call");
        drop(first);
        next.join().unwrap();
    });
    assert_eq!(cache.builds(), 2);
}

/// A warm builds only for a root whose graph can be held: a root never built here is judged by the size of its files.
#[test]
fn a_warm_of_an_unmeasured_tree_builds_nothing() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    cache.prewarm(&root);
    assert_eq!(cache.builds(), 0, "a graph's weight is known only once one is built: no speculative build");
}

/// A warm is admitted by the rule that keeps a graph, over the weight of the root's last build: only when that
/// build was of the files the root has now, and only when it fits. The weight outlives the process.
#[test]
fn a_warm_of_a_measured_tree_follows_the_admission_rule() {
    let (_tmp, root) = project_with_sentinel();
    let (dir, cache) = no_cache();
    cache.graph(&root, &[]).unwrap();
    let cache_dir = dir.path().join("cache");
    let fits = super::GraphCache::new(cache_dir.clone());
    fits.prewarm(&root);
    assert_eq!((fits.builds(), fits.held_roots().len()), (1, 1), "measured, unchanged and fitting: warmed and kept");
    let too_small = super::GraphCache::new(cache_dir.clone()).with_graph_budget(6, 100);
    too_small.prewarm(&root);
    assert_eq!(too_small.builds(), 0, "a graph the rule would not keep is not built");
    fs::write(root.join("src/a.mjs"), "export const a = 123456;\n").unwrap();
    let changed = super::GraphCache::new(cache_dir);
    changed.prewarm(&root);
    assert_eq!(changed.builds(), 0, "the weight measured for other files says nothing about these");
}

/// A graph the cache dropped while a call still uses it stays alive and counts against the budget until its last
/// owner lets go: a graph that would not fit beside it is not kept. Nothing waits for it.
#[test]
fn an_evicted_graph_still_in_use_counts_against_the_budget() {
    let (_t1, one) = project_with_sentinel();
    let (_t2, two) = project_with_sentinel();
    let (_t3, three) = project_with_sentinel();
    let (_sized, sizer) = no_cache();
    let fits_one = super::graph::Graph::build(&one, &[], &sizer).unwrap().base_heap_bytes() * 3 / 2;
    let (_dir, cache) = no_cache();
    let cache = cache.with_graph_budget(6, fits_one);
    let first = cache.graph(&one, &[]).unwrap();
    drop(cache.graph(&two, &[]).unwrap());
    assert!(cache.held_roots().is_empty(), "the second graph does not fit beside the first one, which is still in use");
    drop(cache.graph(&three, &[]).unwrap());
    assert_eq!(cache.builds(), 3, "a build runs while an evicted graph is in use");
    assert!(cache.held_roots().is_empty());
    drop(first);
    cache.graph(&one, &[]).unwrap();
    assert_eq!(cache.held_roots().len(), 1, "the budget is free again once the last owner let go");
}

/// Queries on several roots at once, each retiring the others' graphs while they are in use, all complete.
#[test]
fn concurrent_queries_on_several_roots_all_complete_while_graphs_are_retired() {
    let projects: Vec<_> = (0..3).map(|_| project_with_sentinel()).collect();
    let (_sized, sizer) = no_cache();
    let fits_one = super::graph::Graph::build(&projects[0].1, &[], &sizer).unwrap().base_heap_bytes() * 3 / 2;
    let (_dir, cache) = no_cache();
    let cache = std::sync::Arc::new(cache.with_graph_budget(6, fits_one));
    let (done, finished) = std::sync::mpsc::channel();
    for n in 0..6 {
        let (cache, root, done) = (cache.clone(), projects[n % 3].1.clone(), done.clone());
        std::thread::spawn(move || {
            for _ in 0..3 {
                let lease = cache.graph(&root, &[]).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(5));
                drop(lease);
            }
            done.send(()).unwrap();
        });
    }
    for _ in 0..6 {
        finished.recv_timeout(std::time::Duration::from_secs(60)).expect("a query stalled");
    }
}

/// A source that no longer matches its graph on the retry too fails the call: empty reads would drop results.
#[test]
fn a_source_that_changes_under_both_attempts_fails_the_call() {
    let (_tmp, root) = project_with_sentinel();
    let input = serde_json::json!({ "mode": "references", "symbol": "a" });
    super::graph::FORCED_MISMATCHES.with(|n| n.set(1));
    let retried = run_with(input.clone(), &root);
    assert!(retried.text.contains("src/b.mjs"), "one changed read is answered by the retry: {}", retried.text);
    assert_eq!(super::graph::FORCED_MISMATCHES.with(std::cell::Cell::get), 0, "the references mode reads sources");
    // Another project: the first one's sources are in the read cache now, and a cached read never reaches the disk.
    let (_other, root) = project_with_sentinel();
    super::graph::FORCED_MISMATCHES.with(|n| n.set(1000));
    let (_dir, cache) = no_cache();
    let env = dispatch::Env { trust: &no_roots(), cache: &cache, session_cwd: &root };
    let failed = dispatch::run(&Args::parse(&input), &root, &env);
    super::graph::FORCED_MISMATCHES.with(|n| n.set(0));
    assert!(failed.err().is_some_and(|e| e.contains("changed while the query ran")));
}

/// A config edited while the imports are being linked: the edges are made again from it, not kept beside its new stamp.
#[test]
fn a_config_edited_while_imports_are_linked_does_not_leave_the_old_edges() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    for (rel, text) in [
        ("package.json", "{}"),
        ("tsconfig.json", r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["web/lib/*"]}}}"#),
        ("web/alias.ts", "import { add } from '@lib/math';\nexport const x = add;\n"),
        ("web/lib/math.ts", "export const add = 1;\n"),
        ("web/other/math.ts", "export const add = 2;\n"),
    ] {
        fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
        fs::write(root.join(rel), text).unwrap();
    }
    let config = root.join("tsconfig.json");
    let mut edited = false;
    super::graph::AFTER_LINK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            if !std::mem::replace(&mut edited, true) {
                fs::write(&config, r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["web/other/*"]}}}"#).unwrap();
            }
        }));
    });
    let (_dir, cache) = no_cache();
    let graph = cache.graph(&root, &[]).unwrap();
    super::graph::AFTER_LINK.with(|hook| *hook.borrow_mut() = None);
    assert_eq!(graph.node("web/alias.ts").unwrap().resolved_imports, vec!["web/other/math.ts".to_owned()]);
}

/// Source text is read from disk only as queries need it, through a cache bounded in bytes.
#[test]
fn the_source_cache_stays_within_its_byte_bound() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("package.json"), "{}").unwrap();
    let body = format!("export const x = 1;\n// {}\n", "p".repeat(1_900_000));
    for n in 0..6 {
        fs::write(root.join(format!("f{n}.mjs")), &body).unwrap();
    }
    let (_dir, cache) = no_cache();
    let graph = cache.graph(&root, &[]).unwrap();
    for n in 0..6 {
        assert_eq!(graph.node(&format!("f{n}.mjs")).unwrap().read().text(), body);
    }
    let (bytes, entries) = super::graph::source_cache_state();
    assert!(bytes <= 8 * 1024 * 1024 || entries == 1, "{bytes} bytes in {entries} entries");
}

#[test]
fn the_heap_budget_and_entry_count_evict_the_oldest_graph() {
    let (_t1, one) = project_with_sentinel();
    let (_t2, two) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    // A graph over the whole budget serves its call and is not held, nor kept alive by a pending write.
    let tiny = cache.with_graph_budget(6, 1);
    tiny.graph(&one, &[]).unwrap();
    assert!(tiny.held_roots().is_empty() && !tiny.has_pending());
    tiny.graph(&one, &[]).unwrap();
    assert_eq!(tiny.builds(), 2, "an oversized graph is built again");
    // A budget that fits one graph and not two evicts the oldest.
    let fits_one = super::graph::Graph::build(&one, &[], &tiny).unwrap().base_heap_bytes() * 3 / 2;
    let (_dir, cache) = no_cache();
    let cache = cache.with_graph_budget(6, fits_one);
    cache.graph(&one, &[]).unwrap();
    cache.graph(&two, &[]).unwrap();
    assert_eq!(cache.held_roots(), vec![super::roots::path_key(&two)], "over budget the oldest goes");
    cache.graph(&one, &[]).unwrap();
    assert_eq!(cache.builds(), 3, "the evicted root is built again");
    let (_dir, cache) = no_cache();
    let cache = cache.with_graph_budget(1, u64::MAX);
    cache.graph(&one, &[]).unwrap();
    cache.graph(&two, &[]).unwrap();
    assert_eq!(cache.held_roots(), vec![super::roots::path_key(&two)], "the entry count bounds the cache");
}

/// The resolver reads manifests, so editing only one must not return the edges built from the old one.
#[test]
fn a_manifest_only_edit_invalidates_the_held_graph() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    for (rel, text) in [
        ("package.json", "{}"),
        ("tsconfig.json", r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["web/lib/*"]}}}"#),
        ("web/alias.ts", "import { add } from '@lib/math';\nexport const x = add;\n"),
        ("web/lib/math.ts", "export const add = 1;\n"),
        ("web/other/math.ts", "export const add = 2;\n"),
    ] {
        fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
        fs::write(root.join(rel), text).unwrap();
    }
    let (_dir, cache) = no_cache();
    let first = cache.graph(&root, &[]).unwrap();
    assert_eq!(first.node("web/alias.ts").unwrap().resolved_imports, vec!["web/lib/math.ts".to_owned()]);
    fs::write(root.join("tsconfig.json"), r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["web/other/*"]}}}"#).unwrap();
    let second = cache.graph(&root, &[]).unwrap();
    assert_eq!(second.node("web/alias.ts").unwrap().resolved_imports, vec!["web/other/math.ts".to_owned()]);
}

/// Call sites are not kept in nodes: they are extracted from the source when a caller query asks, and the answer
/// is the same as when they were.
#[test]
fn call_sites_are_extracted_on_demand_for_callers_and_callees() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join("src/a.mjs"), "export function f() { return 1; }\n").unwrap();
    fs::write(root.join("src/b.mjs"), "import { f } from './a.mjs';\nexport function g() { return f(); }\n").unwrap();
    let root = root.canonicalize().unwrap();
    let node_calls = |graph: &super::graph::Graph| graph.node("src/b.mjs").unwrap().calls().unwrap().iter().map(|c| c.name.clone()).collect::<Vec<_>>();
    let (_dir, cache) = no_cache();
    let graph = cache.graph(&root, &[]).unwrap();
    assert_eq!(node_calls(&graph), ["f"]);
    let callers = run_with(serde_json::json!({ "mode": "callers", "symbol": "f" }), &root);
    assert!(callers.text.contains("src/b.mjs"), "{}", callers.text);
    let callees = run_with(serde_json::json!({ "mode": "callees", "symbol": "g", "file": "src/b.mjs" }), &root);
    assert!(callees.text.contains("decl src/a.mjs:1"), "{}", callees.text);
}

/// The resolver follows `extends`: an alias edited only in the base config must not leave the old edges.
#[test]
fn an_edit_to_an_extended_config_invalidates_the_held_graph() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    for (rel, text) in [
        ("package.json", "{}"),
        ("tsconfig.json", r#"{"extends":"./base.json"}"#),
        ("base.json", r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["web/lib/*"]}}}"#),
        ("web/alias.ts", "import { add } from '@lib/math';\nexport const x = add;\n"),
        ("web/lib/math.ts", "export const add = 1;\n"),
        ("web/other/math.ts", "export const add = 2;\n"),
    ] {
        fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
        fs::write(root.join(rel), text).unwrap();
    }
    let (_dir, cache) = no_cache();
    let first = cache.graph(&root, &[]).unwrap();
    assert_eq!(first.node("web/alias.ts").unwrap().resolved_imports, vec!["web/lib/math.ts".to_owned()]);
    fs::write(root.join("base.json"), r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["web/other/*"]}}}"#).unwrap();
    let second = cache.graph(&root, &[]).unwrap();
    assert_eq!(second.node("web/alias.ts").unwrap().resolved_imports, vec!["web/other/math.ts".to_owned()]);
}

/// Memory of a real tree under the bounded representation (run with `--ignored --nocapture`): this repository's own
/// sources. "Before" is what the same graph held when every node kept its file's text.
#[test]
#[ignore = "a measurement, not a check"]
fn measure_the_heap_of_this_repositorys_graph() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap().to_path_buf();
    let (_dir, cache) = no_cache();
    let started = std::time::Instant::now();
    let graph = super::graph::Graph::build(&repo, &[], &cache).unwrap();
    let built = started.elapsed();
    let source_bytes: u64 = graph.nodes.iter().filter_map(|n| n.fingerprint).map(|(size, _)| size).sum();
    let now = graph.base_heap_bytes();
    let words = graph.word_table();
    // What the tokens weighed as a `Vec<String>` per node (the representation before the word table).
    let tokens: u64 = graph.nodes.iter().map(|n| n.tokens.iter().map(|id| 24 + words[*id as usize].len() as u64).sum::<u64>()).sum();
    // What the call sites would weigh if every node kept them (they are extracted on demand now).
    let (calls, call_bytes) = graph.nodes.iter().filter_map(|n| n.calls()).fold((0usize, 0u64), |(count, bytes), calls| {
        let weight: u64 = calls.iter().map(|c| (std::mem::size_of_val(c) + c.name.len() + c.recv.len() + c.in_symbol.len()) as u64).sum();
        (count + calls.len(), bytes + weight)
    });
    let symbols: usize = graph.nodes.iter().map(|n| n.symbols.len()).sum();
    let symbol_bytes: u64 =
        graph.nodes.iter().flat_map(|n| n.symbols.iter()).map(|s| (std::mem::size_of_val(s) + s.name.len() + s.sig.len() + s.parent.len()) as u64).sum();
    let token_count: usize = graph.nodes.iter().map(|n| n.tokens.len()).sum();
    println!(
        "calls={calls} ({:.1}MiB if kept) symbols={symbols} ({:.1}MiB) tokens={token_count} unique_tokens={} (unique text {:.1}MiB) call_cache={:?}",
        call_bytes as f64 / 1048576.0,
        symbol_bytes as f64 / 1048576.0,
        words.len(),
        words.iter().map(|t| t.len()).sum::<usize>() as f64 / 1048576.0,
        super::graph::call_site_cache_state()
    );
    cache.flush().unwrap();
    let payload: u64 = fs::read_dir(_dir.path().join("cache")).unwrap().flatten().filter(|e| e.file_name() != "manifest.json").map(|e| e.metadata().unwrap().len()).sum();
    println!(
        "files={} truncated={} source={:.1}MiB heap_now={:.1}MiB (tokens as per-node strings would be {:.1}MiB) payload={:.1}MiB built_in={built:?}",
        graph.nodes.len(),
        graph.truncated,
        source_bytes as f64 / 1048576.0,
        now as f64 / 1048576.0,
        tokens as f64 / 1048576.0,
        payload as f64 / 1048576.0,
    );
}

/// Crossing the file cap without changing any indexed file's signature still changes `truncated`.
#[test]
fn crossing_the_file_cap_invalidates_the_held_graph() {
    let (_tmp, root) = project_with_sentinel();
    super::graph::FILE_CAP.with(|cap| cap.set(2));
    let (_dir, cache) = no_cache();
    let first = cache.graph(&root, &[]).unwrap();
    assert!(!first.truncated);
    fs::write(root.join("src/c.mjs"), "export const c = 3;\n").unwrap();
    let second = cache.graph(&root, &[]).unwrap();
    super::graph::FILE_CAP.with(|cap| cap.set(super::graph::MAX_FILES));
    assert!(second.truncated, "the graph reports it no longer holds every file");
    assert_eq!(cache.builds(), 2);
}

#[test]
fn an_unchanged_rebuild_from_the_disk_cache_stages_nothing() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    super::graph::Graph::build(&root, &[], &cache).unwrap();
    cache.flush().unwrap();
    super::graph::Graph::build(&root, &[], &cache).unwrap();
    assert!(!cache.has_pending());
}

/// The edges Node's graph takes from the `mixdog-graph` binary: a go.mod module path, a Java package, a C# namespace,
/// Rust `mod`/`use`, a tsconfig path alias, a workspace package, and a Python module looked up from the root, `src/`
/// and `lib/` (never beside the importer). A rebuild with every file from the cache keeps what the index keys on.
#[test]
fn imports_resolve_through_manifests_packages_and_namespaces_as_the_binary_does() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    let files = [
        ("package.json", r#"{"name":"root","private":true,"workspaces":["packages/*"]}"#),
        ("tsconfig.json", r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["web/lib/*"]}}}"#),
        ("packages/shared/package.json", r#"{"name":"@acme/shared","main":"index.ts"}"#),
        ("packages/shared/index.ts", "export function sharedThing(): number { return 1; }\n"),
        ("web/lib/math.ts", "export function add(a: number, b: number): number { return a + b; }\n"),
        ("web/alias.ts", "import { add } from '@lib/math';\nexport function viaAlias() { return add(3, 4); }\n"),
        ("web/pkg.ts", "import { sharedThing } from '@acme/shared';\nexport function viaPkg() { return sharedThing(); }\n"),
        ("Cargo.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"),
        ("src/main.rs", "mod geom;\nuse crate::geom::shapes::circle_area;\n\nfn main() {\n    println!(\"{}\", circle_area(1.0));\n}\n"),
        ("src/geom/mod.rs", "pub mod shapes;\n"),
        ("src/geom/shapes.rs", "pub fn circle_area(r: f64) -> f64 {\n    3.14 * r * r\n}\n"),
        ("go.mod", "module example.com/demo\n\ngo 1.21\n"),
        ("gopkg/geo/geo.go", "package geo\n\nfunc Total(xs []float64) float64 {\n\treturn xs[0]\n}\n"),
        ("gopkg/cmd/main.go", "package main\n\nimport \"example.com/demo/gopkg/geo\"\n\nfunc main() {\n\t_ = geo.Total([]float64{1, 2})\n}\n"),
        ("java/com/acme/util/Calc.java", "package com.acme.util;\n\npublic class Calc {\n    public static int twice(int x) { return x * 2; }\n}\n"),
        ("java/com/acme/app/Main.java", "package com.acme.app;\n\nimport com.acme.util.Calc;\n\npublic class Main {\n    public static void main(String[] a) { System.out.println(Calc.twice(2)); }\n}\n"),
        ("cs/Util/Helper.cs", "namespace Acme.Util {\n    public static class Helper {\n        public static int Triple(int x) { return x * 3; }\n    }\n}\n"),
        ("cs/App/Program.cs", "using Acme.Util;\n\nnamespace Acme.App {\n    class Program {\n        static void Main() { System.Console.WriteLine(Helper.Triple(2)); }\n    }\n}\n"),
        ("pyproj/geo.py", "def area(r):\n    return r * r\n"),
        ("pyproj/use.py", "from geo import area\n\n\ndef run():\n    return area(2)\n"),
        ("src/pkg/__init__.py", ""),
        ("src/pkg/core.py", "def thing():\n    return 1\n"),
        ("app.py", "from pkg.core import thing\n\n\ndef go():\n    return thing()\n"),
    ];
    for (rel, text) in files {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let expected = [
        ("web/alias.ts", vec!["web/lib/math.ts"]),
        ("web/pkg.ts", vec!["packages/shared/index.ts"]),
        ("src/main.rs", vec!["src/geom/mod.rs", "src/geom/shapes.rs"]),
        ("src/geom/mod.rs", vec!["src/geom/shapes.rs"]),
        ("gopkg/cmd/main.go", vec!["gopkg/geo/geo.go"]),
        ("java/com/acme/app/Main.java", vec!["java/com/acme/util/Calc.java"]),
        ("cs/App/Program.cs", vec!["cs/Util/Helper.cs"]),
        ("pyproj/use.py", vec![]),
        ("app.py", vec!["src/pkg/core.py"]),
    ];
    let (_dir, cache) = no_cache();
    let fresh = super::graph::Graph::build(&root, &[], &cache).unwrap();
    cache.flush().unwrap();
    let cached = super::graph::Graph::build(&root, &[], &cache).unwrap();
    for graph in [&fresh, &cached] {
        for (rel, imports) in &expected {
            assert_eq!(graph.node(rel).unwrap().resolved_imports, *imports, "{rel}");
        }
        assert_eq!(graph.dependents("gopkg/geo/geo.go"), vec!["gopkg/cmd/main.go".to_owned()]);
        // packageName / namespaceName / goPackageName as the binary's record carries them, fresh and from the cache.
        let names = |rel: &str| {
            let node = graph.node(rel).unwrap();
            (node.package_name.clone(), node.namespace_name.clone(), node.go_package_name.clone())
        };
        assert_eq!(names("java/com/acme/util/Calc.java"), ("com.acme.util".to_owned(), String::new(), String::new()));
        assert_eq!(names("cs/Util/Helper.cs"), (String::new(), "Acme.Util".to_owned(), String::new()));
        assert_eq!(names("gopkg/geo/geo.go"), (String::new(), String::new(), "geo".to_owned()));
    }
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

/// `guardCodeGraph` (`arg-guard.mjs`): the refusal texts, the hidden `prewarm` mode, and the symbols a file mode drops.
#[test]
fn the_argument_guard_answers_with_the_texts_of_the_argument_guard() {
    let refusal = |args: serde_json::Value| super::guard_args(args).unwrap_err();
    assert_eq!(refusal(serde_json::json!({})), "Error: code_graph requires \"mode\"");
    assert_eq!(refusal(serde_json::json!({"mode": 4})), "Error: code_graph arg \"mode\" must be a string (got number)");
    assert_eq!(
        refusal(serde_json::json!({"mode": "bogus"})),
        "Error: code_graph arg \"mode\" must be one of overview|imports|dependents|related|impact|symbols|find_symbol|symbol_search|search|references|callers|callees|prewarm (got \"bogus\")"
    );
    assert_eq!(refusal(serde_json::Value::Null), "Error: code_graph requires arguments object (got null)");
    assert!(super::guard_args(serde_json::json!({"mode": " prewarm "})).is_ok());
    let kept = super::guard_args(serde_json::json!({"mode": "imports", "file": "a.rs", "symbol": "x", "symbols": ["y"], "files": [[], null]})).unwrap();
    assert_eq!(kept, serde_json::json!({"mode": "imports", "file": "a.rs"}));
    let symbols = super::guard_args(serde_json::json!({"mode": "callers", "symbol": "x"})).unwrap();
    assert_eq!(symbols["symbol"], "x");
    // A `file` list joins `files` ahead of its anchors, or takes the place of a `files` that is no list.
    let joined = super::guard_args(serde_json::json!({"mode": "symbols", "file": ["a", ["b"]], "files": ["c"]})).unwrap();
    assert_eq!(joined, serde_json::json!({"mode": "symbols", "files": ["a", "b", "c"]}));
    let replaced = super::guard_args(serde_json::json!({"mode": "symbols", "file": [], "files": "c"})).unwrap();
    assert_eq!(replaced, serde_json::json!({"mode": "symbols", "files": []}));
    let one = super::guard_args(serde_json::json!({"mode": "symbols", "file": "a"})).unwrap();
    assert_eq!(one, serde_json::json!({"mode": "symbols", "file": "a"}));
}
