//! Golden tests: every `fixtures/tools/code_graph/*.json` case against a small project.
#![allow(clippy::disallowed_methods, reason = "the test builds a project on disk with blocking filesystem calls")]

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
    let symbol_of = |graph: &super::graph::Graph| graph.node("src/a.mjs").unwrap().symbols.get(0).name.to_owned();
    let first = super::graph::Graph::build(&root, &[], &cache).unwrap();
    assert_eq!(symbol_of(&first), "a");
    cache.flush().unwrap();
    // Alter the cached copy in place: a build that answers with it has reused the entry.
    let payload =
        fs::read_dir(cache_dir.path().join("cache")).unwrap().flatten().map(|e| e.path()).find(|p| p.file_name().unwrap() != "manifest.json").unwrap();
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

/// What a graph answers, per file: its symbols, the imports it resolves and the files that depend on it.
fn answers(graph: &super::graph::Graph) -> Vec<(String, Vec<String>, Vec<String>, Vec<String>)> {
    let mut rows: Vec<_> = graph
        .nodes
        .iter()
        .map(|node| (node.rel.clone(), node.symbols.iter().map(|s| s.name.to_owned()).collect(), node.resolved_imports.clone(), graph.dependents(&node.rel)))
        .collect();
    rows.sort();
    rows
}

/// A scoped build (the root minus a nested project) is held and refreshed like a whole root's: a second call reuses it, and
/// after edits, an addition and a deletion it answers exactly as a build from nothing does, parsing only what changed.
#[test]
fn a_scoped_build_is_held_and_refreshed_and_answers_as_a_build_from_nothing() {
    let (_tmp, root) = project_with_sentinel();
    let nested = root.join("nested");
    fs::create_dir_all(nested.join("src")).unwrap();
    fs::write(nested.join("package.json"), "{}").unwrap();
    fs::write(nested.join("src/n.mjs"), "export const n = 1;\n").unwrap();
    let excluded = vec![nested.clone()];
    let (_dir, cache) = no_cache();
    let fresh = || {
        let (_dir, other) = no_cache();
        answers(&super::graph::Graph::build(&root, &excluded, &other).unwrap())
    };
    let first = cache.graph(&root, &excluded).unwrap();
    assert!(first.node("nested/src/n.mjs").is_none(), "the nested project is left out");
    assert_eq!(answers(&first.graph), fresh());
    let second = cache.graph(&root, &excluded).unwrap();
    assert_eq!(cache.builds(), 1, "the scoped build is held");
    assert!(std::sync::Arc::ptr_eq(&first.graph, &second.graph));
    let base = parsed();
    fs::write(root.join("src/a.mjs"), "export const a = 1;\nexport function more() {}\n").unwrap();
    let edited = cache.graph(&root, &excluded).unwrap();
    assert_eq!(parsed() - base, 1, "only the changed file is parsed again");
    assert_eq!(answers(&edited.graph), fresh());
    fs::write(root.join("src/c.mjs"), "import { b } from './b.mjs';\nexport const c = b;\n").unwrap();
    assert_eq!(answers(&cache.graph(&root, &excluded).unwrap().graph), fresh());
    fs::remove_file(root.join("src/a.mjs")).unwrap();
    assert_eq!(answers(&cache.graph(&root, &excluded).unwrap().graph), fresh());
    // The whole root's graph is its own: the scope does not stand in for it.
    assert!(cache.graph(&root, &[]).unwrap().node("nested/src/n.mjs").is_some());
}

fn parsed() -> usize {
    super::graph::PARSED.with(std::cell::Cell::get)
}

fn ask(cache: &super::GraphCache, root: &Path, input: Value) -> super::dispatch::Answer {
    let env = dispatch::Env { trust: &no_roots(), cache, session_cwd: root };
    dispatch::run(&Args::parse(&input), root, &env).unwrap()
}

/// A change is picked up whoever made it: an outside write, and a session write told to the cache (even one that leaves the
/// size and the modification time as they were), give the same fresh answer, and only the changed file is parsed again.
#[test]
fn an_outside_write_and_a_session_write_give_the_same_fresh_answer_and_only_the_changed_file_is_parsed() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    cache.graph(&root, &[]).unwrap();
    let base = parsed();
    fs::write(root.join("src/a.mjs"), "export const a = 1;\nexport function outside() {}\n").unwrap();
    let outside = cache.graph(&root, &[]).unwrap();
    assert!(outside.node("src/a.mjs").unwrap().symbols.iter().any(|s| s.name == "outside"));
    assert_eq!(outside.dependents("src/a.mjs"), ["src/b.mjs"]);
    assert_eq!(parsed() - base, 1, "b.mjs did not change and is not parsed again");
    // The same size and the same modification time: only the session's own notice can tell.
    let path = root.join("src/b.mjs");
    let stamp = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, "import { a } from './a.mjs';\nexport const q = a;\n").unwrap();
    fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(stamp).unwrap();
    let unseen = cache.graph(&root, &[]).unwrap();
    assert!(unseen.node("src/b.mjs").unwrap().symbols.iter().any(|s| s.name == "b"), "no notice, no change in the inventory: the old record stands");
    cache.note_changed(&[path.to_string_lossy().replace('\\', "/")]);
    let session = cache.graph(&root, &[]).unwrap();
    assert!(session.node("src/b.mjs").unwrap().symbols.iter().any(|s| s.name == "q"));
    assert_eq!(parsed() - base, 2, "only the noticed file was parsed");
}

/// Additions, deletions, renames and a file's eligibility changing are all reconciled, and the links are made again over
/// the result: an import that did not resolve resolves when its target appears.
#[test]
fn additions_deletions_renames_and_eligibility_changes_are_reconciled() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let first = cache.graph(&root, &[]).unwrap();
    assert_eq!(first.dependents("src/a.mjs"), ["src/b.mjs"]);
    fs::remove_file(root.join("src/a.mjs")).unwrap();
    let deleted = cache.graph(&root, &[]).unwrap();
    assert!(deleted.node("src/a.mjs").is_none());
    assert!(deleted.node("src/b.mjs").unwrap().resolved_imports.is_empty());
    assert!(deleted.dependents("src/a.mjs").is_empty());
    fs::write(root.join("src/a.mjs"), "export const a = 1;\n").unwrap();
    let added = cache.graph(&root, &[]).unwrap();
    assert_eq!(added.node("src/b.mjs").unwrap().resolved_imports, ["src/a.mjs"], "a previously unresolved import resolves");
    assert_eq!(added.dependents("src/a.mjs"), ["src/b.mjs"]);
    fs::rename(root.join("src/a.mjs"), root.join("src/c.mjs")).unwrap();
    let renamed = cache.graph(&root, &[]).unwrap();
    assert!(renamed.node("src/a.mjs").is_none() && renamed.node("src/c.mjs").is_some());
    assert!(renamed.node("src/b.mjs").unwrap().resolved_imports.is_empty());
    // No longer eligible (a type the graph does not index), then eligible again.
    fs::rename(root.join("src/c.mjs"), root.join("src/c.txt")).unwrap();
    assert!(cache.graph(&root, &[]).unwrap().node("src/c.mjs").is_none());
    fs::rename(root.join("src/c.txt"), root.join("src/a.mjs")).unwrap();
    let back = cache.graph(&root, &[]).unwrap();
    assert_eq!(back.node("src/b.mjs").unwrap().resolved_imports, ["src/a.mjs"]);
}

/// A symbol added to a file that was not a candidate for it before: the empty answer of a moment ago is populated.
#[test]
fn a_symbol_added_to_a_file_that_was_not_a_candidate_populates_a_previously_empty_answer() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let query = serde_json::json!({ "mode": "find_symbol", "symbol": "freshly_added" });
    let before = ask(&cache, &root, query.clone());
    assert!(!before.text.contains("src/b.mjs"), "{}", before.text);
    fs::write(root.join("src/b.mjs"), "import { a } from './a.mjs';\nexport function freshly_added() { return a; }\n").unwrap();
    let after = ask(&cache, &root, query);
    assert!(after.text.contains("src/b.mjs"), "{}", after.text);
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

/// A source that changes during a call re-parses only that file; a source that keeps failing verification
/// past retries is omitted as unverified with a completeness warning instead of failing with "run it again".
#[test]
fn a_source_that_changes_during_a_call_reparses_instead_of_failing() {
    let (_tmp, root) = project_with_sentinel();
    let input = serde_json::json!({ "mode": "references", "symbol": "a" });
    super::graph::FORCED_MISMATCHES.with(|n| n.set(1));
    let retried = run_with(input.clone(), &root);
    assert!(retried.complete && retried.text.contains("src/b.mjs"), "one changed read is answered by re-parsing that file: {}", retried.text);
    assert_eq!(super::graph::FORCED_MISMATCHES.with(std::cell::Cell::get), 0, "the references mode reads sources");
    // Another project, every read of which finds its file changed: omits unverified files rather than failing.
    let (_other, root) = project_with_sentinel();
    super::graph::FORCED_MISMATCHES.with(|n| n.set(1000));
    let (_dir, cache) = no_cache();
    let env = dispatch::Env { trust: &no_roots(), cache: &cache, session_cwd: &root };
    let degraded = dispatch::run(&Args::parse(&input), &root, &env).expect("continuous mismatch degrades to unverified warning");
    super::graph::FORCED_MISMATCHES.with(|n| n.set(0));
    assert!(!degraded.complete && !degraded.warnings.is_empty(), "{}", degraded.text);
    let wrapped = super::output::wrap(degraded.text, &degraded.warnings, &Args::parse(&input));
    assert!(wrapped.starts_with("[warning] graph incomplete"), "{wrapped}");
}

#[test]
fn an_overview_with_an_outline_does_not_open_the_source_for_a_preview() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let env = dispatch::Env { trust: &no_roots(), cache: &cache, session_cwd: &root };
    let args = Args::parse(&serde_json::json!({ "mode": "overview", "files": ["src/a.mjs"] }));
    let previous = super::graph::FORCED_MISMATCHES.with(|left| left.replace(1));
    let answer = dispatch::run(&args, &root, &env);
    let unread = super::graph::FORCED_MISMATCHES.with(|left| left.replace(previous));
    let text = answer.unwrap().text;
    assert!(text.lines().any(|line| line.contains(" a (L1)")), "{text}");
    assert_eq!(unread, 1, "no preview read should consume the injected disk-read mismatch");
}

#[test]
fn populated_source_and_call_site_caches_do_not_mask_changed_file_bytes() {
    let (_tmp, root) = reader_project();
    let (_dir, cache) = no_cache();
    let lease = cache.graph(&root, &[]).unwrap();
    let node = lease.node("src/user.mjs").unwrap();
    assert!(node.read().text().contains("target();"));
    assert!(node.calls().unwrap().iter().any(|call| call.name == "target"));
    same_size_rewrite(&root.join("src/user.mjs"), "import { target } from './lib.mjs';\nexport function go() { lonely(); }\n");
    assert_eq!(node.read().text(), "");
    assert!(node.calls().is_none());
    assert!(lease.source_stale());
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

#[test]
fn imports_recheck_same_stamp_sources_and_manifests_before_serving_cached_edges() {
    let (_tmp, root) = project_with_sentinel();
    for (rel, text) in [
        ("tsconfig.json", r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/a/*"]}}}"#),
        ("src/use.ts", "import { x } from '@lib/x';"),
        ("src/a/x.ts", "export const x = 1;"),
        ("src/b/x.ts", "export const x = 2;"),
        ("src/b/y.ts", "export const x = 3;"),
    ] {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let (_dir, cache) = no_cache();
    let input = serde_json::json!({ "mode": "imports", "file": "src/use.ts" });
    assert_eq!(ask(&cache, &root, input.clone()).text.lines().next(), Some("src/a/x.ts"));
    same_size_rewrite(&root.join("tsconfig.json"), r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/b/*"]}}}"#);
    assert_eq!(ask(&cache, &root, input.clone()).text.lines().next(), Some("src/b/x.ts"));
    same_size_rewrite(&root.join("src/use.ts"), "import { x } from '@lib/y';");
    assert_eq!(ask(&cache, &root, input).text.lines().next(), Some("src/b/y.ts"));
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

/// A graph over the held budget that a call still uses is what the next call of its root takes, not a second parse beside
/// it; once no call uses it, it is gone.
#[test]
fn a_declined_graph_still_in_use_is_shared_by_the_next_call_of_its_root() {
    let (_t, one) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = cache.with_graph_budget(6, 1);
    let first = cache.graph(&one, &[]).unwrap();
    let second = cache.graph(&one, &[]).unwrap();
    assert!(cache.held_roots().is_empty(), "over the held budget: not retained");
    assert!(std::sync::Arc::ptr_eq(&first.graph, &second.graph));
    assert_eq!(cache.builds(), 1);
    drop((first, second));
    cache.graph(&one, &[]).unwrap();
    assert_eq!(cache.builds(), 2, "a declined graph no call uses is not kept");
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
    let before = parsed();
    let second = cache.graph(&root, &[]).unwrap();
    assert_eq!(second.node("web/alias.ts").unwrap().resolved_imports, vec!["web/other/math.ts".to_owned()]);
    assert_eq!(second.dependents("web/other/math.ts"), ["web/alias.ts"]);
    assert!(second.dependents("web/lib/math.ts").is_empty());
    assert_eq!(parsed(), before, "a manifest change links again and parses no source");
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

/// A monorepo of ~11,000 files is indexed whole: the files that sort last (`z/`) are not what the cap drops.
#[test]
fn a_project_past_ten_thousand_files_is_indexed_whole() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir_all(root.join("z")).unwrap();
    for i in 0..10_100 {
        fs::write(root.join(format!("a/f{i}.mjs")), format!("export const v{i} = {i};\n")).unwrap();
    }
    fs::write(root.join("z/last.mjs"), "export const last = 1;\n").unwrap();
    let (_dir, cache) = no_cache();
    let graph = cache.graph(&root, &[]).unwrap();
    assert!(!graph.incomplete());
    assert!(graph.nodes.iter().any(|n| n.rel == "z/last.mjs"));
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
        (
            "java/com/acme/app/Main.java",
            "package com.acme.app;\n\nimport com.acme.util.Calc;\n\npublic class Main {\n    public static void main(String[] a) { System.out.println(Calc.twice(2)); }\n}\n",
        ),
        ("cs/Util/Helper.cs", "namespace Acme.Util {\n    public static class Helper {\n        public static int Triple(int x) { return x * 3; }\n    }\n}\n"),
        (
            "cs/App/Program.cs",
            "using Acme.Util;\n\nnamespace Acme.App {\n    class Program {\n        static void Main() { System.Console.WriteLine(Helper.Triple(2)); }\n    }\n}\n",
        ),
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
    assert_eq!(roots_of(serde_json::json!({ "mode": "imports", "file": "src/b.mjs" }), &root), Some(vec![root.clone(), root.join("src/b.mjs")]));
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
    let output = super::ToolOutput { meta: Some(serde_json::json!({ super::DEPENDENCY_ROOTS_META: ["/p", "/p/a.rs"] })), ..super::ToolOutput::default() };
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

// File versions: what a record stands for is the digest of the bytes it was parsed from.

/// A rewrite that keeps the size and the modification time, as an outside writer within the clock's granularity would.
fn same_size_rewrite(path: &Path, text: &str) {
    let stamp = fs::metadata(path).unwrap().modified().unwrap();
    fs::write(path, text).unwrap();
    fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(stamp).unwrap();
}

fn tell(cache: &super::GraphCache, path: &Path) {
    cache.note_changed(&[path.to_string_lossy().replace('\\', "/")]);
}

fn calls_project() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join("src/c.mjs"), "export function f() { return g(); }\n").unwrap();
    fs::write(root.join("src/b.mjs"), "export const b = 1;\n").unwrap();
    let root = root.canonicalize().unwrap();
    (tmp, root)
}

/// What a node says of its file, three ways: the outline, the body and the call sites. They must always agree.
fn view(graph: &super::graph::Graph) -> (Vec<String>, String, Vec<String>) {
    let node = graph.node("src/c.mjs").unwrap();
    (node.symbols.iter().map(|s| s.name.to_owned()).collect(), node.read().text().to_owned(), node.calls().unwrap().iter().map(|c| c.name.clone()).collect())
}

/// A hinted edit that leaves size and mtime as they were, with the call-site cache populated: symbols, bodies and calls
/// all show the new bytes.
#[test]
fn a_hinted_same_stamp_edit_is_seen_by_symbols_bodies_and_calls() {
    let (_tmp, root) = calls_project();
    let (_dir, cache) = no_cache();
    let first = cache.graph(&root, &[]).unwrap();
    assert_eq!(view(&first), (vec!["f".to_owned()], "export function f() { return g(); }\n".to_owned(), vec!["g".to_owned()]));
    same_size_rewrite(&root.join("src/c.mjs"), "export function q() { return h(); }\n");
    tell(&cache, &root.join("src/c.mjs"));
    let second = cache.graph(&root, &[]).unwrap();
    assert_eq!(view(&second), (vec!["q".to_owned()], "export function q() { return h(); }\n".to_owned(), vec!["h".to_owned()]));
}

/// The same hint, with the generation evicted before the refresh: the disk copy has the old record at the same stamp and must
/// not be admitted.
#[test]
fn a_hint_survives_the_eviction_of_the_graph_before_the_refresh() {
    let (_tmp, root) = calls_project();
    let (_dir, cache) = no_cache();
    drop(cache.graph(&root, &[]).unwrap());
    cache.flush().unwrap();
    same_size_rewrite(&root.join("src/c.mjs"), "export function q() { return h(); }\n");
    tell(&cache, &root.join("src/c.mjs"));
    cache.evict_all();
    assert_eq!(view(&cache.graph(&root, &[]).unwrap()).0, ["q"]);
}

/// Evicted, and the staged write of the new generation never happened (nothing kept the graph alive): the invalidation is
/// still there, and the obsolete disk record is not resurrected.
#[test]
fn a_hint_survives_the_eviction_of_the_graph_before_its_persistence() {
    let (_tmp, root) = calls_project();
    let (_dir, cache) = no_cache();
    drop(cache.graph(&root, &[]).unwrap());
    cache.flush().unwrap();
    same_size_rewrite(&root.join("src/c.mjs"), "export function q() { return h(); }\n");
    tell(&cache, &root.join("src/c.mjs"));
    drop(cache.graph(&root, &[]).unwrap());
    cache.evict_all();
    cache.flush().unwrap();
    let after = cache.graph(&root, &[]).unwrap();
    assert_eq!(view(&after), (vec!["q".to_owned()], "export function q() { return h(); }\n".to_owned(), vec!["h".to_owned()]));
}

/// A cache loaded from disk admits records that carry a digest without parsing them, and parses the ones that do not.
#[test]
fn a_disk_reload_admits_records_with_a_digest_and_parses_those_without() {
    let (_tmp, root) = calls_project();
    let (dir, cache) = no_cache();
    drop(cache.graph(&root, &[]).unwrap());
    cache.flush().unwrap();
    let cache_dir = dir.path().join("cache");
    let before = parsed();
    let reloaded = super::GraphCache::new(cache_dir.clone());
    let graph = reloaded.graph(&root, &[]).unwrap();
    assert_eq!(parsed(), before, "unchanged stamps are not read again");
    assert_eq!(view(&graph).1, "export function f() { return g(); }\n");
    let payload = fs::read_dir(&cache_dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "json") && p.file_name().unwrap() != "manifest.json")
        .unwrap();
    let stripped = regex::Regex::new(r#""digest":"[0-9a-f]{64}""#).unwrap().replace_all(&fs::read_to_string(&payload).unwrap(), r#""digest":"""#).into_owned();
    fs::write(&payload, stripped).unwrap();
    let before = parsed();
    let reparsed = super::GraphCache::new(cache_dir).graph(&root, &[]).unwrap();
    assert_eq!(parsed() - before, 2, "records without a digest are parsed again");
    assert_eq!(view(&reparsed).0, ["f"]);
}

/// An old generation still read after the file changed finds the bytes are not its record's: its answer is empty and only it
/// is marked; the new generation reads the new bytes.
#[test]
fn old_and_new_generations_each_read_their_own_version() {
    let (_tmp, root) = calls_project();
    let (_dir, cache) = no_cache();
    let old = cache.graph(&root, &[]).unwrap();
    fs::write(root.join("src/c.mjs"), "export function q() { return h2(); }\n").unwrap();
    let new = cache.graph(&root, &[]).unwrap();
    assert_eq!(new.node("src/c.mjs").unwrap().read().text(), "export function q() { return h2(); }\n");
    assert!(!new.source_stale());
    assert_eq!(old.node("src/c.mjs").unwrap().read().text(), "", "the old record's version is gone from disk");
    assert!(old.source_stale() && !new.source_stale());
}

/// A hint for a file rewritten with the very same bytes: the record is parsed again and everything still agrees.
#[test]
fn a_hint_that_rewrites_identical_bytes_changes_nothing_it_shows() {
    let (_tmp, root) = calls_project();
    let (_dir, cache) = no_cache();
    let first = view(&cache.graph(&root, &[]).unwrap());
    let before = parsed();
    same_size_rewrite(&root.join("src/c.mjs"), "export function f() { return g(); }\n");
    tell(&cache, &root.join("src/c.mjs"));
    let again = view(&cache.graph(&root, &[]).unwrap());
    assert_eq!(parsed() - before, 1);
    assert_eq!(first, again);
}

/// A hint made before the root is first asked for (another cache instance, the same disk) still forbids the disk copy.
#[test]
fn a_hint_before_the_root_is_registered_is_kept_for_it() {
    let (_tmp, root) = calls_project();
    let (dir, cache) = no_cache();
    drop(cache.graph(&root, &[]).unwrap());
    cache.flush().unwrap();
    same_size_rewrite(&root.join("src/c.mjs"), "export function q() { return h(); }\n");
    let fresh = super::GraphCache::new(dir.path().join("cache"));
    tell(&fresh, &root.join("src/c.mjs"));
    assert_eq!(view(&fresh.graph(&root, &[]).unwrap()), (vec!["q".to_owned()], "export function q() { return h(); }\n".to_owned(), vec!["h".to_owned()]));
}

// Unstable input: one observation per file.

fn grow_while_read(path: std::path::PathBuf, always: bool) {
    let mut writes = 0usize;
    super::graph::AFTER_READ.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            if always || writes == 0 {
                let mut text = fs::read_to_string(&path).unwrap();
                text.push_str("// grown while it was read\n");
                fs::write(&path, text).unwrap();
            }
            writes += 1;
        }));
    });
}

fn stop_growing() {
    super::graph::AFTER_READ.with(|hook| *hook.borrow_mut() = None);
}

/// A file mutated while it is parsed is left out (its old record does not stand in for it), the rest of the project is
/// indexed, the omission is visible, and the next query parses it again even though the tree's signature is what it was.
#[test]
fn a_file_mutated_while_it_is_parsed_is_left_out_disclosed_and_recovered_on_the_next_query() {
    let (_tmp, root) = project_with_sentinel();
    let path = root.join("src/a.mjs");
    let (_dir, cache) = no_cache();
    drop(cache.graph(&root, &[]).unwrap());
    grow_while_read(path.clone(), false);
    // A stamp change makes the file be parsed on this refresh; the hook then changes it under the read.
    let edited = "export const a = 1;\nexport const a2 = 2;\n";
    fs::write(&path, edited).unwrap();
    // What the next inventory will see once the file is as the tree's signature recorded it.
    let stamp = fs::metadata(&path).unwrap().modified().unwrap();
    let during = cache.graph(&root, &[]).unwrap();
    stop_growing();
    assert_eq!(during.unverified, ["src/a.mjs"]);
    assert!(during.node("src/a.mjs").is_none(), "no record, old or new, stands for the file");
    assert!(during.node("src/b.mjs").unwrap().symbols.iter().any(|s| s.name == "b"), "an unrelated outline is kept");
    assert!(during.incomplete() && during.incomplete_note().contains("src/a.mjs"));
    // The tree is back to what the signature recorded: only the unverified file tells the cache to look again.
    fs::write(&path, edited).unwrap();
    fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(stamp).unwrap();
    let after = cache.graph(&root, &[]).unwrap();
    assert!(after.unverified.is_empty() && after.node("src/a.mjs").is_some());
    assert_eq!(after.dependents("src/a.mjs"), ["src/b.mjs"]);
}

/// An unavailable fact is never an authoritative negative: a file that could not be verified is "ask again", not "absent".
#[test]
fn a_file_that_could_not_be_verified_is_never_answered_as_absent() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    grow_while_read(root.join("src/a.mjs"), true);
    let outline = ask(&cache, &root, serde_json::json!({ "mode": "imports", "file": "src/a.mjs" }));
    stop_growing();
    assert!(outline.text.contains("changed while it was being read") && !outline.text.contains("no file exists"), "{}", outline.text);
    assert!(!outline.complete);
}

// Memory: nothing is left out for size; retention is the held budget's to decide; tokens follow what is live.

#[test]
fn a_graph_that_is_not_retained_answers_completely_and_is_rebuilt_observably() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = cache.with_graph_budget(6, 1);
    let answer = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "b" }));
    assert!(answer.complete && answer.text.contains("src/b.mjs"), "{}", answer.text);
    assert!(cache.held_roots().is_empty(), "over the held budget: not retained");
    assert_eq!(cache.builds(), 1);
    assert!(ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "b" })).text.contains("src/b.mjs"));
    assert_eq!(cache.builds(), 2, "and rebuilt on the next call");
    assert_eq!(cache.graph(&root, &[]).unwrap().nodes.len(), 2);
}

/// The word table follows what is live: a token only a replaced record had is released once the last reader of that
/// generation is gone.
#[test]
fn replaced_tokens_are_released_once_old_readers_are_gone() {
    let (_tmp, root) = project_with_sentinel();
    fs::write(root.join("src/a.mjs"), "export const old_only_token_zq = 1;\n").unwrap();
    let (_dir, cache) = no_cache();
    let old = cache.graph(&root, &[]).unwrap();
    assert!(old.live_words().iter().any(|w| w == "old_only_token_zq"));
    fs::write(root.join("src/a.mjs"), "export const new_only_token_zqx = 1;\n").unwrap();
    let new = cache.graph(&root, &[]).unwrap();
    assert!(new.live_words().iter().any(|w| w == "old_only_token_zq"), "an old reader still holds it");
    drop(old);
    let live = new.live_words();
    assert!(!live.iter().any(|w| w == "old_only_token_zq"), "released: {live:?}");
    assert!(live.iter().any(|w| w == "new_only_token_zqx"));
}

// Timing: one row per call, attributed per call.

struct Capture(std::sync::Arc<std::sync::Mutex<Vec<std::collections::BTreeMap<String, String>>>>);

struct Fields(std::collections::BTreeMap<String, String>);

impl tracing::field::Visit for Fields {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().to_owned(), format!("{value:?}").trim_matches('"').to_owned());
    }
}

impl tracing::Subscriber for Capture {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut fields = Fields(Default::default());
        event.record(&mut fields);
        self.0.lock().unwrap().push(fields.0);
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

fn capturing<T>(work: impl FnOnce() -> T) -> (T, Vec<std::collections::BTreeMap<String, String>>) {
    let rows = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let out = tracing::subscriber::with_default(Capture(rows.clone()), work);
    let rows = rows.lock().unwrap().clone();
    (out, rows)
}

/// Timings are the calling thread's: another call's durations are not inherited, and a take starts afresh.
#[test]
fn concurrent_calls_do_not_inherit_each_others_durations() {
    let _ = super::cache::take_timings();
    super::cache::note(|t| t.parse_ms += 7);
    let other = std::thread::spawn(|| {
        let none = super::cache::take_timings();
        super::cache::note(|t| t.link_ms += 3);
        (none.parse_ms, super::cache::take_timings().link_ms)
    })
    .join()
    .unwrap();
    assert_eq!(other, (0, 3));
    let mine = super::cache::take_timings();
    assert_eq!((mine.parse_ms, mine.link_ms), (7, 0));
    assert_eq!(super::cache::take_timings().parse_ms, 0, "a take starts afresh");
}

/// The wait in the helper's queue is its own stage in the row, and neither the query nor `other` takes it over.
#[test]
fn a_queue_wait_is_its_own_stage_and_is_not_charged_to_the_query_or_other() {
    let timings = mixdog_graph_host::wire::Timings { queue_ms: 50, run_ms: 30, prune_ms: 5, wrap_ms: 5, parse_ms: 10, ..Default::default() };
    let row = super::CallRow { request: 9, mode: "symbols", outcome: "ok", timings, total_ms: 100 };
    let (_, rows) = capturing(|| row.emit());
    let call = &rows[0];
    assert_eq!(call["request"], "9");
    assert_eq!(call["queue_ms"], "50");
    assert_eq!(call["parse_ms"], "10");
    assert_eq!(call["query_ms"], "20", "the run minus the graph's own stages");
    assert_eq!(call["other_ms"], "10", "what no stage accounts for is labelled other: {call:?}");
}

// ---- the hint ledger: revisions of canonical paths, receipts of what an artifact processed ----

const B_Q: &str = "import { a } from './a.mjs';\nexport const q = a;\n";
const B_R: &str = "import { a } from './a.mjs';\nexport const r = a;\n";

/// Rewrites a file with the size and modification time it had: only a hint can tell.
fn rewrite_keeping_stamp(path: &Path, text: &str) {
    let stamp = fs::metadata(path).unwrap().modified().unwrap();
    fs::write(path, text).unwrap();
    fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(stamp).unwrap();
}

fn told(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn symbols_of(graph: &super::graph::Graph, rel: &str) -> Vec<String> {
    graph.node(rel).unwrap().symbols.iter().map(|s| s.name.to_owned()).collect()
}

fn revision_of(cache: &super::GraphCache, root: &Path, rel: &str) -> Option<u64> {
    cache.ledger().snapshot(&super::roots::identity_key(root).unwrap()).get(&identity_of(root, rel)).copied()
}

/// The identity a file has: its link-resolved, normalised path.
fn identity_of(root: &Path, rel: &str) -> String {
    super::roots::identity_key(&root.join(rel)).unwrap()
}

/// The revision `graph` acknowledged of the file `rel` under `root`.
fn receipt_of(graph: &super::graph::Graph, root: &Path, rel: &str) -> Option<u64> {
    graph.receipts.get(&identity_of(root, rel)).copied()
}

use super::cache::LedgerHooks;

/// Position one of the publication race: a write has reserved its revision and is paused holding the ledger. A refresh of
/// another change cannot snapshot past it, so it processes the hint once the write is published.
#[test]
fn a_write_paused_under_the_ledger_lock_cannot_be_passed_by_a_refresh() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    cache.graph(&root, &[]).unwrap();
    let path = root.join("src/b.mjs");
    rewrite_keeping_stamp(&path, B_Q);
    let ledger = cache.ledger();
    let (reserved_tx, reserved_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    ledger.set_hooks(LedgerHooks {
        under_note: Some(Box::new(move || {
            reserved_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        })),
        ..Default::default()
    });
    std::thread::scope(|scope| {
        let writer = scope.spawn(|| cache.note_changed(&[told(&path)]));
        reserved_rx.recv().unwrap();
        let (at_lock_tx, at_lock_rx) = std::sync::mpsc::channel();
        ledger.set_hooks(LedgerHooks { before_snapshot: Some(Box::new(move || at_lock_tx.send(()).unwrap())), ..Default::default() });
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let (cache, root) = (&cache, &root);
        let refresher = scope.spawn(move || {
            let graph = cache.graph(root, &[]).unwrap();
            done_tx.send(()).unwrap();
            graph
        });
        at_lock_rx.recv().unwrap();
        assert!(done_rx.try_recv().is_err(), "the refresh cannot finish past a reserved, unpublished revision");
        release_tx.send(()).unwrap();
        writer.join().unwrap();
        let graph = refresher.join().unwrap();
        assert!(symbols_of(&graph, "src/b.mjs").contains(&"q".to_owned()), "the refresh processed the hint");
        assert_eq!(receipt_of(&graph, &root, "src/b.mjs"), revision_of(&cache, &root, "src/b.mjs"));
        assert!(receipt_of(&graph, &root, "src/b.mjs").is_some());
    });
}

/// Position two: the write has not reached the ledger. The refresh may finish without the hint but cannot acknowledge it,
/// and the next refresh processes it.
#[test]
fn a_write_paused_before_the_ledger_lock_is_not_acknowledged_and_the_next_refresh_processes_it() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    cache.graph(&root, &[]).unwrap();
    let path = root.join("src/b.mjs");
    rewrite_keeping_stamp(&path, B_Q);
    let (paused_tx, paused_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    cache.ledger().set_hooks(LedgerHooks {
        before_note: Some(Box::new(move || {
            paused_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        })),
        ..Default::default()
    });
    std::thread::scope(|scope| {
        let writer = scope.spawn(|| cache.note_changed(&[told(&path)]));
        paused_rx.recv().unwrap();
        let without = cache.graph(&root, &[]).unwrap();
        assert!(symbols_of(&without, "src/b.mjs").contains(&"b".to_owned()), "the hint was not published: the old record stands");
        assert!(without.receipts.is_empty(), "nothing was acknowledged");
        release_tx.send(()).unwrap();
        writer.join().unwrap();
    });
    let next = cache.graph(&root, &[]).unwrap();
    assert!(symbols_of(&next, "src/b.mjs").contains(&"q".to_owned()));
    assert_eq!(receipt_of(&next, &root, "src/b.mjs"), revision_of(&cache, &root, "src/b.mjs"));
}

/// Revision A is hinted and a refresh takes its snapshot; revision B is published before the refresh ends. Returns the
/// revisions and the generation A's refresh published.
fn publish_b_during_refresh_of_a(cache: &std::sync::Arc<super::GraphCache>, root: &Path) -> (u64, u64, super::cache::Lease) {
    cache.graph(root, &[]).unwrap();
    let path = root.join("src/b.mjs");
    rewrite_keeping_stamp(&path, B_Q);
    cache.note_changed(&[told(&path)]);
    let revision_a = revision_of(cache, root, "src/b.mjs").unwrap();
    let (writer, writer_path) = (cache.clone(), path.clone());
    cache.ledger().set_hooks(LedgerHooks {
        after_snapshot: Some(Box::new(move || {
            rewrite_keeping_stamp(&writer_path, B_R);
            writer.note_changed(&[told(&writer_path)]);
        })),
        ..Default::default()
    });
    let during = cache.graph(root, &[]).unwrap();
    let revision_b = revision_of(cache, root, "src/b.mjs").unwrap();
    assert!(revision_b > revision_a);
    (revision_a, revision_b, during)
}

#[test]
fn a_revision_published_during_a_refresh_is_not_acknowledged_by_it() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = std::sync::Arc::new(cache);
    let (revision_a, revision_b, during) = publish_b_during_refresh_of_a(&cache, &root);
    assert_eq!(receipt_of(&during, &root, "src/b.mjs"), Some(revision_a));
    let base = parsed();
    let next = cache.graph(&root, &[]).unwrap();
    assert_eq!(parsed() - base, 1, "the held generation never processed B: the file is parsed again");
    assert!(symbols_of(&next, "src/b.mjs").contains(&"r".to_owned()));
    assert_eq!(receipt_of(&next, &root, "src/b.mjs"), Some(revision_b));
}

#[test]
fn a_revision_published_during_the_persistence_of_another_is_not_acknowledged_by_it() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = std::sync::Arc::new(cache);
    let (_, revision_b, _during) = publish_b_during_refresh_of_a(&cache, &root);
    cache.flush().unwrap();
    cache.evict_all();
    let base = parsed();
    let from_disk = cache.graph(&root, &[]).unwrap();
    assert_eq!(parsed() - base, 1, "the payload processed A, not B: only b.mjs is parsed, a.mjs comes from the disk");
    assert!(symbols_of(&from_disk, "src/b.mjs").contains(&"r".to_owned()));
    assert_eq!(receipt_of(&from_disk, &root, "src/b.mjs"), Some(revision_b));
}

/// Every same-stamp write noted before the first query is refreshed, however many: nothing caps the ledger.
#[test]
fn more_than_4096_same_stamp_writes_before_the_first_query_are_all_refreshed() {
    const FILES: usize = 4200;
    let (tmp, root) = project_with_sentinel();
    let (dir, first) = no_cache();
    let rel = |n: usize| format!("src/f{n}.mjs");
    for n in 0..FILES {
        fs::write(root.join(rel(n)), format!("export const v{n:05} = 1;\n")).unwrap();
    }
    first.graph(&root, &[]).unwrap();
    first.flush().unwrap();
    assert!(first.load(&root).is_some_and(|files| files.len() == FILES + 2), "the disk holds every record");
    for n in 0..FILES {
        rewrite_keeping_stamp(&root.join(rel(n)), &format!("export const w{n:05} = 1;\n"));
    }
    let later = super::GraphCache::new(dir.path().join("cache"));
    for n in 0..FILES {
        later.note_changed(&[told(&root.join(rel(n)))]);
    }
    let graph = later.graph(&root, &[]).unwrap();
    let stale: Vec<usize> = (0..FILES).filter(|n| !symbols_of(&graph, &rel(*n)).contains(&format!("w{n:05}"))).collect();
    assert!(stale.is_empty(), "{} files answered from their obsolete record, first {:?}", stale.len(), stale.first());
    drop(tmp);
}

/// A notification made before either root is queried, whether the parent is already registered or not, reaches the parent
/// and, after the parent has been queried, persisted and evicted, the nested root too.
fn a_notification_reaches_a_parent_and_its_nested_root(parent_registered: bool) {
    let tmp = tempfile::tempdir().unwrap();
    let (parent, sub) = (tmp.path().join("proj"), tmp.path().join("proj/sub"));
    fs::create_dir_all(&sub).unwrap();
    for dir in [&parent, &sub] {
        fs::write(dir.join("package.json"), "{}").unwrap();
    }
    fs::write(parent.join("a.mjs"), "export const a = 1;\n").unwrap();
    fs::write(sub.join("b.mjs"), "export const b = 1;\n").unwrap();
    let (parent, sub) = (parent.canonicalize().unwrap(), sub.canonicalize().unwrap());
    let cache_dir = tmp.path().join("cache");
    let earlier = super::GraphCache::new(cache_dir.clone());
    earlier.graph(&parent, &[]).unwrap();
    earlier.graph(&sub, &[]).unwrap();
    earlier.flush().unwrap();
    let written = sub.join("b.mjs");
    rewrite_keeping_stamp(&written, "export const c = 1;\n");
    let cache = super::GraphCache::new(cache_dir);
    if parent_registered {
        cache.graph(&parent, &[]).unwrap();
    }
    cache.note_changed(&[told(&written)]);
    let whole = cache.graph(&parent, &[]).unwrap();
    assert!(symbols_of(&whole, "sub/b.mjs").contains(&"c".to_owned()), "the parent refreshed the file");
    drop(whole);
    cache.flush().unwrap();
    cache.evict_all();
    let nested = cache.graph(&sub, &[]).unwrap();
    assert!(symbols_of(&nested, "b.mjs").contains(&"c".to_owned()), "the nested root refreshed it too, from a disk record that is obsolete");
}

#[test]
fn a_notification_before_either_root_is_queried_reaches_the_parent_and_the_nested_root() {
    a_notification_reaches_a_parent_and_its_nested_root(false);
}

#[test]
fn a_notification_with_the_parent_already_registered_reaches_the_parent_and_the_nested_root() {
    a_notification_reaches_a_parent_and_its_nested_root(true);
}

/// A generation that was never written (its staging discarded, or its write skipped) acknowledged nothing on disk: the
/// next build from the disk copy does not reuse the record the hint obsoleted.
fn an_unwritten_generation_leaves_the_disk_record_unvouched(abandon: impl FnOnce(&mut super::GraphCache)) {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, mut cache) = no_cache();
    cache.graph(&root, &[]).unwrap();
    cache.flush().unwrap();
    let path = root.join("src/b.mjs");
    rewrite_keeping_stamp(&path, B_Q);
    cache.note_changed(&[told(&path)]);
    let refreshed = cache.graph(&root, &[]).unwrap();
    assert!(symbols_of(&refreshed, "src/b.mjs").contains(&"q".to_owned()));
    drop(refreshed);
    abandon(&mut cache);
    cache.evict_all();
    let rebuilt = cache.graph(&root, &[]).unwrap();
    assert!(symbols_of(&rebuilt, "src/b.mjs").contains(&"q".to_owned()), "the disk's record of b.mjs is obsolete and is not reused");
}

#[test]
fn a_discarded_staged_generation_does_not_let_the_disk_rebuild_reuse_the_obsolete_record() {
    an_unwritten_generation_leaves_the_disk_record_unvouched(|cache| cache.discard_staged());
}

#[test]
fn a_skipped_write_does_not_let_the_disk_rebuild_reuse_the_obsolete_record() {
    an_unwritten_generation_leaves_the_disk_record_unvouched(|cache| {
        cache.set_max_bytes(10);
        cache.flush().unwrap();
    });
}

/// Revisions are numbers of one lifetime: a payload of an earlier lifetime whose receipts name the same number does not vouch
/// for a record of the later lifetime's hint.
#[test]
fn a_payload_of_an_earlier_lifetime_does_not_vouch_for_the_hint_of_a_later_one() {
    let (_tmp, root) = project_with_sentinel();
    let (dir, earlier) = no_cache();
    earlier.graph(&root, &[]).unwrap();
    let path = root.join("src/b.mjs");
    rewrite_keeping_stamp(&path, B_Q);
    earlier.note_changed(&[told(&path)]);
    let processed = earlier.graph(&root, &[]).unwrap();
    let revision = receipt_of(&processed, &root, "src/b.mjs").unwrap();
    earlier.flush().unwrap();
    rewrite_keeping_stamp(&path, B_R);
    let later = super::GraphCache::new(dir.path().join("cache"));
    later.note_changed(&[told(&path)]);
    assert_eq!(revision_of(&later, &root, "src/b.mjs"), Some(revision), "the same number, another lifetime");
    let graph = later.graph(&root, &[]).unwrap();
    assert!(symbols_of(&graph, "src/b.mjs").contains(&"r".to_owned()));
}

// ---- parse warnings and call rows ----

fn project_with_an_unindexable_file() -> (tempfile::TempDir, std::path::PathBuf) {
    let (tmp, root) = project_with_sentinel();
    fs::write(root.join("src/bad.mjs"), [0xff, 0xfe, 0x00]).unwrap();
    (tmp, root)
}

/// File-scoped queries avoid loading unrelated unindexable files only when the requested files
/// completely determine the answer; whenever project-wide context is needed they fall back to the
/// full graph and preserve both its answer and its parse warnings.
#[test]
fn an_answer_is_exempt_from_parse_warnings_only_when_it_used_a_verified_one_file_graph() {
    let (_tmp, root) = project_with_an_unindexable_file();
    let (_dir, cache) = no_cache();
    let outline = ask(&cache, &root, serde_json::json!({ "mode": "symbols", "file": "src/a.mjs" }));
    assert!(outline.warnings.is_empty() && outline.complete, "a one-file outline is answered from that file alone");
    let several = ask(&cache, &root, serde_json::json!({ "mode": "symbols", "files": ["src/a.mjs", "src/b.mjs"] }));
    assert!(several.warnings.is_empty() && several.complete, "multi-file symbols parses only those files");
    let declared_here = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "a", "file": "src/a.mjs" }));
    assert!(declared_here.warnings.is_empty() && declared_here.complete, "a declaration in the requested file needs only that file");
    let declared_outside = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "a", "file": "src/b.mjs" }));
    assert!(declared_outside.text.contains("declared outside the requested files: src/a.mjs:1"), "{}", declared_outside.text);
    assert!(!declared_outside.warnings.is_empty() && !declared_outside.complete, "outside-scope declaration uses the whole graph");
    let missing = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "missing", "file": "src/a.mjs" }));
    assert!(missing.text.contains("graph: nodes=3"), "{}", missing.text);
    assert!(!missing.warnings.is_empty() && !missing.complete, "no-match find_symbol uses the whole graph");
    let unscoped = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "a" }));
    assert!(!unscoped.warnings.is_empty() && !unscoped.complete, "unscoped find_symbol uses the whole graph");
    let imports = ask(&cache, &root, serde_json::json!({ "mode": "imports", "file": "src/a.mjs" }));
    assert!(!imports.warnings.is_empty() && !imports.complete, "imports uses the whole graph");
}

// ---- file identity: link-resolved, one function for notices, roots and inventory entries ----

/// A directory link: a symlink, or a junction on Windows (no privilege needed).
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

fn unlink_dir(link: &Path) {
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
    #[cfg(unix)]
    fs::remove_file(link).unwrap();
}

fn alias_of(root: &Path) -> std::path::PathBuf {
    let alias = root.parent().unwrap().join("alias");
    link_dir(&alias, root);
    alias
}

/// A graph whose every source a query has read: the old record and its reads are both present when the file is rewritten.
fn warm(cache: &super::GraphCache, root: &Path) {
    let graph = cache.graph(root, &[]).unwrap();
    for node in &graph.nodes {
        node.read();
    }
}

#[test]
fn a_write_notified_through_an_alias_reaches_the_graph_of_the_real_root() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let alias = alias_of(&root);
    warm(&cache, &root);
    rewrite_keeping_stamp(&root.join("src/b.mjs"), B_Q);
    cache.note_changed(&[told(&alias.join("src/b.mjs"))]);
    let graph = cache.graph(&root, &[]).unwrap();
    assert!(symbols_of(&graph, "src/b.mjs").contains(&"q".to_owned()));
    assert!(receipt_of(&graph, &root, "src/b.mjs").is_some());
}

#[test]
fn a_write_notified_through_the_real_path_reaches_the_graph_of_an_alias_root() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let alias = alias_of(&root);
    warm(&cache, &alias);
    rewrite_keeping_stamp(&root.join("src/b.mjs"), B_Q);
    cache.note_changed(&[told(&root.join("src/b.mjs"))]);
    let graph = cache.graph(&alias, &[]).unwrap();
    assert!(symbols_of(&graph, "src/b.mjs").contains(&"q".to_owned()));
    assert!(receipt_of(&graph, &root, "src/b.mjs").is_some());
}

/// A deleted file notified through an alias whose linked parent survives is identified through that parent.
#[test]
fn a_deleted_file_notified_through_an_alias_is_identified_by_its_surviving_linked_parent() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let alias = alias_of(&root);
    warm(&cache, &root);
    fs::remove_file(root.join("src/b.mjs")).unwrap();
    assert!(cache.note_resolved(&[told(&alias.join("src/b.mjs"))]).is_empty());
    assert!(revision_of(&cache, &root, "src/b.mjs").is_some(), "keyed by the real path, not the alias");
    let graph = cache.graph(&root, &[]).unwrap();
    assert!(graph.node("src/b.mjs").is_none());
    assert_eq!(receipt_of(&graph, &root, "src/b.mjs"), revision_of(&cache, &root, "src/b.mjs"), "established as contributing no record");
}

/// A nested root queried through a link: the parent and the nested graph both receive the revision.
#[test]
fn a_nested_root_queried_through_a_link_and_its_parent_both_receive_the_revision() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let sub = root.join("sub");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("package.json"), "{}").unwrap();
    fs::write(sub.join("c.mjs"), "export const c = 1;\n").unwrap();
    let alias = alias_of(&sub);
    warm(&cache, &root);
    warm(&cache, &alias);
    rewrite_keeping_stamp(&sub.join("c.mjs"), "export const d = 1;\n");
    cache.note_changed(&[told(&alias.join("c.mjs"))]);
    let whole = cache.graph(&root, &[]).unwrap();
    assert!(symbols_of(&whole, "sub/c.mjs").contains(&"d".to_owned()));
    let nested = cache.graph(&alias, &[]).unwrap();
    assert!(symbols_of(&nested, "c.mjs").contains(&"d".to_owned()));
}

/// Identity is taken when the notice is ingested: the hint stays with the file it resolved to then.
#[test]
fn a_hint_stays_with_the_target_the_alias_had_when_it_was_notified() {
    let (_ta, one) = project_with_sentinel();
    let (_tb, two) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let alias = alias_of(&one);
    warm(&cache, &one);
    warm(&cache, &two);
    rewrite_keeping_stamp(&one.join("src/b.mjs"), B_Q);
    rewrite_keeping_stamp(&two.join("src/b.mjs"), B_Q);
    cache.note_changed(&[told(&alias.join("src/b.mjs"))]);
    unlink_dir(&alias);
    link_dir(&alias, &two);
    let first = cache.graph(&one, &[]).unwrap();
    assert!(symbols_of(&first, "src/b.mjs").contains(&"q".to_owned()), "the original target keeps the hint");
    let second = cache.graph(&two, &[]).unwrap();
    assert!(symbols_of(&second, "src/b.mjs").contains(&"b".to_owned()), "the new target never got it");
    assert!(second.receipts.is_empty());
}

#[test]
fn a_missing_tail_resolves_through_its_surviving_ancestor_and_a_failure_has_no_lexical_key() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let alias = alias_of(&root);
    let through = super::roots::identity_key(&alias.join("not/yet/there.mjs")).unwrap();
    assert_eq!(through, identity_of(&root, "not/yet/there.mjs"), "the real location, not the alias spelling");
    assert_ne!(through, super::roots::path_key(&alias.join("not/yet/there.mjs")));
    // A dangling link: its target is gone, the entry is not.
    let gone = root.parent().unwrap().join("gone");
    fs::create_dir_all(&gone).unwrap();
    let dangling = root.parent().unwrap().join("dangling");
    link_dir(&dangling, &gone);
    fs::remove_dir(&gone).unwrap();
    assert!(super::roots::identity_key(&dangling.join("x.mjs")).is_err());
    let before = cache.ledger().len();
    let unresolved = cache.note_resolved(&[told(&dangling.join("x.mjs"))]);
    assert_eq!(unresolved.len(), 1, "reported, not dropped silently");
    assert_eq!(cache.ledger().len(), before + 1, "and recorded under no file key, lexical or otherwise: only the unknown location");
    assert!(cache.ledger().snapshot("nothing/under/this").contains_key(super::cache::Ledger::UNKNOWN));
    assert!(cache.graph(&dangling, &[]).is_err(), "a root with no identity builds no graph");
    #[cfg(unix)]
    {
        let (a, b) = (root.parent().unwrap().join("loop-a"), root.parent().unwrap().join("loop-b"));
        std::os::unix::fs::symlink(&b, &a).unwrap();
        std::os::unix::fs::symlink(&a, &b).unwrap();
        assert!(super::roots::identity_key(&a.join("x.mjs")).is_err(), "a link loop is an unresolved identity");
    }
}
/// A directory link whose target is gone: a path through it cannot be resolved.
fn dangling_alias(root: &Path) -> std::path::PathBuf {
    let gone = root.parent().unwrap().join("gone-target");
    fs::create_dir_all(&gone).unwrap();
    let dangling = root.parent().unwrap().join("dangling-alias");
    link_dir(&dangling, &gone);
    fs::remove_dir(&gone).unwrap();
    dangling
}

/// A notice whose location cannot be resolved is a change at an unknown location: every root parses once, then holds the
/// receipt; a later ordinary notice still targets only its path.
#[test]
fn an_unresolvable_notice_makes_every_root_parse_once_and_a_later_notice_targets_only_its_path() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let dangling = dangling_alias(&root);
    warm(&cache, &root);
    rewrite_keeping_stamp(&root.join("src/b.mjs"), B_Q);
    assert_eq!(cache.note_resolved(&[told(&dangling.join("src/b.mjs"))]).len(), 1);
    let base = parsed();
    let first = cache.graph(&root, &[]).unwrap();
    assert!(symbols_of(&first, "src/b.mjs").contains(&"q".to_owned()), "the held record was not reused unverified");
    assert_eq!(parsed() - base, 2, "both source files are parsed");
    assert!(first.receipts.contains_key(super::cache::Ledger::UNKNOWN));
    let base = parsed();
    cache.graph(&root, &[]).unwrap();
    assert_eq!(parsed() - base, 0, "the receipt is held: the second query reuses");
    rewrite_keeping_stamp(&root.join("src/b.mjs"), B_R);
    cache.note_changed(&[told(&root.join("src/b.mjs"))]);
    let after = cache.graph(&root, &[]).unwrap();
    assert!(symbols_of(&after, "src/b.mjs").contains(&"r".to_owned()));
    assert_eq!(parsed() - base, 1, "an ordinary notice reparses only its file");
}

#[test]
fn an_unresolvable_notice_keeps_the_disk_record_from_being_reused_unverified() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let dangling = dangling_alias(&root);
    warm(&cache, &root);
    cache.flush().unwrap();
    rewrite_keeping_stamp(&root.join("src/b.mjs"), B_Q);
    cache.note_changed(&[told(&dangling.join("src/b.mjs"))]);
    cache.evict_all();
    let base = parsed();
    let graph = cache.graph(&root, &[]).unwrap();
    assert!(symbols_of(&graph, "src/b.mjs").contains(&"q".to_owned()));
    assert_eq!(parsed() - base, 2, "no record of the disk copy is vouched for");
    cache.flush().unwrap();
    cache.evict_all();
    let base = parsed();
    cache.graph(&root, &[]).unwrap();
    assert_eq!(parsed() - base, 0, "the payload that processed the unknown-location revision is reused");
}

fn reader_project() -> (tempfile::TempDir, std::path::PathBuf) {
    let (tmp, root) = project_with_sentinel();
    fs::write(
        root.join("src/lib.mjs"),
        "export function target() {}\nexport function x() {}\nexport const y = 1;\nexport const z = 2;\nexport function lonely() {}\n",
    )
    .unwrap();
    fs::write(root.join("src/user.mjs"), "import { target } from './lib.mjs';\nexport function go() { target(); }\n").unwrap();
    fs::write(root.join("src/other.mjs"), "function x() {}\nconst y = x();\nexport function run() { x(); return y; }\n").unwrap();
    (tmp, root)
}

#[test]
fn symbols_stops_at_limit_and_counts_the_rest() {
    let (_tmp, root) = reader_project();
    let text = run_with(serde_json::json!({ "mode": "symbols", "files": ["src/lib.mjs"], "limit": 2 }), &root).text;
    let (rows, note) = text.rsplit_once('\n').unwrap();
    assert_eq!(rows.lines().count(), 2, "{text}");
    assert!(note.contains("+3 more"), "{text}");
}

#[test]
fn symbol_search_cap_keeps_the_best_names_and_declarations_after_scanning_the_scope() {
    let (_tmp, root) = project_with_sentinel();
    fs::write(root.join("a.mjs"), "export function job() {}\nexport function jobLists() {}\n").unwrap();
    fs::write(root.join("src/a.mjs"), "export function runJob() {}\nexport function Job() {}\n").unwrap();
    fs::write(root.join("src/z.mjs"), "export function job() {}\nexport function jobQueue() {}\n").unwrap();
    let text = run_with(serde_json::json!({ "mode": "symbol_search", "symbol": "job", "limit": 2 }), &root).text;
    let rows: Vec<_> = text.lines().collect();
    assert_eq!(rows.len(), 4, "{text}");
    assert_eq!(rows[0], "# search keyword=job matches=5 shown=2");
    assert!(rows[1].starts_with("job\tsrc/z.mjs:1"), "{text}");
    assert!(rows[2].starts_with("Job\tsrc/a.mjs:2"), "{text}");
    assert_eq!(rows[3], "...+3 more resolved (cap=2)");

    let scoped = run_with(serde_json::json!({ "mode": "search", "file": "a.mjs", "symbol": "job", "limit": 1 }), &root).text;
    assert!(scoped.starts_with("# search keyword=job matches=2 shown=1\njob\ta.mjs:1"), "{scoped}");
    assert!(scoped.ends_with("...+1 more resolved (cap=1)"), "{scoped}");
}

#[test]
fn callers_search_the_project_when_files_names_the_declaration() {
    let (_tmp, root) = reader_project();
    let text = run_with(serde_json::json!({ "mode": "callers", "files": ["src/lib.mjs"], "symbol": "target" }), &root).text;
    assert!(text.contains("src/user.mjs"), "{text}");
    let text = run_with(serde_json::json!({ "mode": "callers", "files": ["src/lib.mjs"], "symbol": "lonely" }), &root).text;
    assert!(text.starts_with("(no caller name matches found)") && !text.contains("genuinely unreferenced"), "{text}");
}

#[test]
fn impact_counts_only_references_that_resolve_to_the_file() {
    let (_tmp, root) = reader_project();
    let text = run_with(serde_json::json!({ "mode": "impact", "files": ["src/lib.mjs"] }), &root).text;
    assert!(text.starts_with("# impact: importer-restricted name matches; not binding-resolved references.\n"), "{text}");
    assert!(text.contains("matching_files\t1\n") && text.contains("external_name_matches\t"), "{text}");
    assert!(!text.contains("other.mjs"), "{text}");
}

#[test]
fn callers_follow_star_and_aliased_reexports_through_cycles() {
    let (_tmp, root) = project_with_sentinel();
    fs::write(root.join("src/defs.mjs"), "export function target() {}\n").unwrap();
    fs::write(root.join("src/barrel.mjs"), "export * from './defs.mjs';\nexport * from './loop.mjs';\n").unwrap();
    fs::write(root.join("src/loop.mjs"), "export * from './barrel.mjs';\n").unwrap();
    fs::write(root.join("src/alias.mjs"), "export { target as renamed } from './defs.mjs';\n").unwrap();
    fs::write(root.join("src/viastar.mjs"), "import { target } from './loop.mjs';\nexport function a() { target(); }\n").unwrap();
    fs::write(root.join("src/viaalias.mjs"), "import { renamed } from './alias.mjs';\nexport function b() { renamed(); }\n").unwrap();
    let text = run_with(serde_json::json!({ "mode": "callers", "files": ["src/defs.mjs"], "symbol": "target" }), &root).text;
    assert!(text.contains("src/viastar.mjs") && text.contains("src/viaalias.mjs"), "{text}");
}

#[test]
fn callers_of_a_declaration_include_other_languages_and_never_call_a_passed_name_unreferenced() {
    let (_tmp, root) = project_with_sentinel();
    fs::write(root.join("src/lib.mjs"), "export function handler() {}\nexport function passed() {}\n").unwrap();
    fs::write(root.join("src/user.ts"), "import { handler } from './lib.mjs';\nexport function go() { handler(); }\n").unwrap();
    fs::write(root.join("src/reg.mjs"), "import { passed } from './lib.mjs';\nexport function setup(register) { register(passed); }\n").unwrap();
    let text = run_with(serde_json::json!({ "mode": "callers", "files": ["src/lib.mjs"], "symbol": "handler" }), &root).text;
    assert!(text.contains("src/user.ts"), "{text}");
    let text = run_with(serde_json::json!({ "mode": "callers", "files": ["src/lib.mjs"], "symbol": "passed" }), &root).text;
    assert!(
        text.starts_with("(no caller name matches found)")
            && text.contains("does not establish that 'passed' is unused")
            && !text.contains("genuinely unreferenced"),
        "{text}"
    );
    let text = run_with(serde_json::json!({ "mode": "callers", "files": ["src/user.ts"], "symbol": "passed" }), &root).text;
    assert!(text.starts_with("(no declaration named 'passed' found in the requested files)"), "{text}");
}

#[test]
fn impact_scans_every_symbol_and_transitive_output_ends_without_a_completeness_claim() {
    let (_tmp, root) = reader_project();
    let mut lib = String::new();
    for i in 0..12 {
        lib.push_str(&format!("export function f{i}() {{}}\n"));
    }
    fs::write(root.join("src/lib.mjs"), lib).unwrap();
    fs::write(root.join("src/user.mjs"), "import { f11 } from './lib.mjs';\nexport function go() { f11(); }\n").unwrap();
    let text = run_with(serde_json::json!({ "mode": "impact", "files": ["src/lib.mjs"] }), &root).text;
    assert!(text.contains("scanned_symbols\t12\n") && text.contains("f11\tname_matches="), "{text}");
    let text = run_with(serde_json::json!({ "mode": "callers", "files": ["src/lib.mjs"], "symbol": "f11", "depth": 2 }), &root).text;
    assert!(text.ends_with("# END — end of collected caller-name matches, not a complete binding-resolved caller set. Verify with grep/read."), "{text}");
}

#[test]
fn transitive_callers_are_paged_without_a_traversal_cutoff() {
    let (_tmp, root) = reader_project();
    let mut many = String::from("import { target } from './lib.mjs';\n");
    for i in 0..1001 {
        many.push_str(&format!("export function c{i}() {{ target(); }}\n"));
    }
    fs::write(root.join("src/many.mjs"), many).unwrap();
    let page = |n: usize| {
        run_with(serde_json::json!({ "mode": "callers", "files": ["src/lib.mjs"], "symbol": "target", "depth": 2, "limit": 500, "page": n }), &root).text
    };
    let (first, last) = (page(1), page(3));
    assert!(first.contains("nodes 1-500 of 1002") && first.contains("# NEXT"), "{first}");
    assert!(last.contains("nodes 1001-1002 of 1002") && last.contains("# END") && !last.contains("# NEXT"), "{last}");
}

#[test]
fn a_flat_callers_answer_is_labelled_as_name_matches_with_its_limits() {
    let (_tmp, root) = reader_project();
    let text = run_with(serde_json::json!({ "mode": "callers", "files": ["src/lib.mjs"], "symbol": "target" }), &root).text;
    assert!(
        text.starts_with("# caller-name matches (importer-restricted name matching; not binding-resolved)\n# May include unrelated same-named identifiers;"),
        "{text}"
    );
    assert!(text.contains("src/user.mjs") && !text.contains("# call sites"), "{text}");
}

/// `prewarmCodeGraphIfProject`: a folder inside a project warms the project's graph into the cache; a
/// folder that is no project (here a bare temp folder: the implicit walk stops at it) warms nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prewarm_builds_the_graph_of_the_project_and_only_of_a_project() {
    let (_tmp, root) = project_with_sentinel();
    let dir = tempfile::tempdir().unwrap();
    let host = std::sync::Arc::new(super::testing::InProcessHost::new(dir.path().join("cache")));
    let tool = super::CodeGraphTool::new(std::sync::Arc::new(NoTrust), host.clone());
    let cancel = mixdog_rt::CancellationToken::new();
    // A warm builds nothing for a tree no query has measured: the foreground call fills the cache.
    let cache = host.engine().cache();
    cache.graph(&root, &[]).unwrap();
    assert!(tool.prewarm_if_project(&root.join("src"), mixdog_graph_host::Start::Demand, &cancel).await.unwrap());
    assert_eq!(cache.builds(), 1);
    host.engine().drain().unwrap();
    assert_eq!(cache.load(&root).map(|files| files.len()), Some(2), "both source files are cached");
    let bare = tempfile::tempdir().unwrap();
    assert!(!tool.prewarm_if_project(bare.path(), mixdog_graph_host::Start::Demand, &cancel).await.unwrap());
}
/// Refreshes of one root queue on its turn and the one after finds the generation the first published; writes made while
/// the refreshes run are not lost.
#[test]
fn simultaneous_refreshes_of_one_root_publish_one_generation_and_lose_no_write() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    cache.graph(&root, &[]).unwrap();
    let base = parsed();
    let turn = cache.hold_root(&root);
    let guard = turn.lock().unwrap();
    fs::write(root.join("src/a.mjs"), "export const a = 1;\nexport function w0() {}\n").unwrap();
    let leases: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4).map(|_| scope.spawn(|| cache.graph(&root, &[]).unwrap())).collect();
        std::thread::sleep(std::time::Duration::from_millis(300));
        drop(guard);
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert!(leases.iter().all(|g| std::sync::Arc::ptr_eq(&g.graph, &leases[0].graph)), "one published generation");
    assert!(leases[0].node("src/a.mjs").unwrap().symbols.iter().any(|s| s.name == "w0"));
    // Writers racing readers: whatever the interleaving, the last write is what the next query sees.
    let last = std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            for n in 0..30 {
                let path = root.join("src/a.mjs");
                fs::write(&path, format!("export const a = 1;\nexport function w{n}() {{}}\n")).unwrap();
                cache.note_changed(&[path.to_string_lossy().replace('\\', "/")]);
            }
            29
        });
        for _ in 0..30 {
            // A file rewritten again and again under the resolver's three passes is refused, and says so (the dispatcher
            // retries it once); no other failure is allowed.
            if let Err(refused) = cache.graph(&root, &[]) {
                assert!(refused.contains("kept changing while its imports were linked"), "{refused}");
            }
        }
        writer.join().unwrap()
    });
    let end = cache.graph(&root, &[]).unwrap();
    assert!(end.node("src/a.mjs").unwrap().symbols.iter().any(|s| s.name == format!("w{last}")));
    assert!(parsed() - base < 60, "unchanged b.mjs was never parsed again");
}
/// A root's refresh turn, an unretained graph's lease and another root's persistence are not what a different root waits on.
#[test]
fn a_different_roots_progress_does_not_depend_on_another_roots_turn_or_an_unretained_lease() {
    let (_t1, one) = project_with_sentinel();
    let (_t2, two) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = cache.with_graph_budget(6, 1);
    let unretained = cache.graph(&one, &[]).unwrap();
    assert!(cache.held_roots().is_empty(), "the graph was served and not kept");
    let turn = cache.hold_root(&one);
    let _guard = turn.lock().unwrap();
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(|| sent.send(cache.graph(&two, &[]).map(|g| g.nodes.len())).unwrap());
        let nodes = received.recv_timeout(std::time::Duration::from_secs(20)).expect("another root's refresh must not wait").unwrap();
        assert_eq!(nodes, 2);
    });
    drop(unretained);
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
    let tokens: u64 = graph.nodes.iter().map(|n| n.tokens.iter().map(|id| 24 + words.get(*id).len() as u64).sum::<u64>()).sum();
    // What the call sites would weigh if every node kept them (they are extracted on demand now).
    let (calls, call_bytes) = graph.nodes.iter().filter_map(|n| n.calls()).fold((0usize, 0u64), |(count, bytes), calls| {
        let weight: u64 = calls.iter().map(|c| (std::mem::size_of_val(c) + c.name.len() + c.recv.len() + c.in_symbol.len()) as u64).sum();
        (count + calls.len(), bytes + weight)
    });
    let symbols: usize = graph.nodes.iter().map(|n| n.symbols.len()).sum();
    let symbol_bytes: u64 = graph.nodes.iter().map(|n| n.symbols.heap_bytes()).sum();
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
    let payload: u64 =
        fs::read_dir(_dir.path().join("cache")).unwrap().flatten().filter(|e| e.file_name() != "manifest.json").map(|e| e.metadata().unwrap().len()).sum();
    println!(
        "files={} omitted={} source={:.1}MiB heap_now={:.1}MiB (tokens as per-node strings would be {:.1}MiB) payload={:.1}MiB built_in={built:?}",
        graph.nodes.len(),
        graph.unverified.len(),
        source_bytes as f64 / 1048576.0,
        now as f64 / 1048576.0,
        tokens as f64 / 1048576.0,
        payload as f64 / 1048576.0,
    );
}
/// The omission is attached to every mode that answers from the graph, empty results included, agrees with the
/// completeness metadata and survives the output limit; a single file's outline verified on its own is not warned.
#[test]
fn the_omission_is_attached_to_every_affected_mode_and_agrees_with_the_metadata() {
    let (_tmp, root) = project_with_sentinel();
    fs::write(root.join("src/c.mjs"), "export const c = 3;\n").unwrap();
    let (_dir, cache) = no_cache();
    grow_while_read(root.join("src/c.mjs"), true);
    let calls = [
        serde_json::json!({ "mode": "overview" }),
        serde_json::json!({ "mode": "imports", "file": "src/b.mjs" }),
        serde_json::json!({ "mode": "dependents", "file": "src/a.mjs" }),
        serde_json::json!({ "mode": "related", "file": "src/a.mjs" }),
        serde_json::json!({ "mode": "impact", "file": "src/a.mjs" }),
        serde_json::json!({ "mode": "find_symbol", "symbol": "nothing_here" }),
        serde_json::json!({ "mode": "search", "symbol": "nothing_here" }),
        serde_json::json!({ "mode": "references", "symbol": "nothing_here" }),
        serde_json::json!({ "mode": "callers", "symbol": "nothing_here" }),
        serde_json::json!({ "mode": "callees", "symbol": "b", "file": "src/b.mjs" }),
    ];
    for input in calls {
        let answer = ask(&cache, &root, input.clone());
        assert!(!answer.complete, "{input}: incomplete");
        let wrapped = super::output::wrap(answer.text.clone(), &answer.warnings, &Args::parse(&input));
        assert!(wrapped.starts_with("[warning] graph incomplete"), "{input}: {wrapped}");
        assert!(wrapped.contains("src/c.mjs"), "{input}: {wrapped}");
        // Past the output limit the head is kept: the warning is the first line.
        let long = format!("{}\n{}", answer.text, "row\n".repeat(60_000));
        assert!(super::output::wrap(long, &answer.warnings, &Args::parse(&input)).starts_with("[warning] graph incomplete"), "{input}");
    }
    let one = ask(&cache, &root, serde_json::json!({ "mode": "symbols", "file": "src/a.mjs" }));
    stop_growing();
    assert!(one.complete && one.warnings.is_empty(), "a single file's outline is verified on its own: {}", one.text);
}
/// The wait for a root's refresh turn is its own stage, measured on the call that waited.
#[test]
fn a_root_wait_is_measured_on_the_call_that_waited() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let cache = std::sync::Arc::new(cache);
    let turn = cache.hold_root(&root);
    let guard = turn.lock().unwrap();
    let waiter = {
        let (cache, root) = (cache.clone(), root.clone());
        std::thread::spawn(move || {
            let _ = super::cache::take_timings();
            cache.graph(&root, &[]).unwrap();
            super::cache::take_timings()
        })
    };
    // The wait is real time here (a lock has no clock to move): long enough to be measured, short enough not to matter.
    std::thread::sleep(std::time::Duration::from_millis(120));
    drop(guard);
    let spent = waiter.join().unwrap();
    assert!(spent.root_wait_ms >= 100, "{}ms", spent.root_wait_ms);
    assert_eq!(spent.parsed, 2);
    assert_eq!(spent.retained, Some(true));
    let mine = super::cache::take_timings();
    assert_eq!(mine.root_wait_ms, 0, "this thread waited for nothing");
}
/// Persistence has its own event naming the root and the generation the call reported, however late the flush is.
#[test]
fn background_persistence_emits_its_own_event_for_the_generation_a_call_reported() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    let ((generation, held), rows) = capturing(|| {
        let _ = super::cache::take_timings();
        let graph = cache.graph(&root, &[]).unwrap();
        let spent = super::cache::take_timings();
        // The flush comes later, on another turn of the lane.
        std::thread::sleep(std::time::Duration::from_millis(20));
        cache.flush().unwrap();
        (spent.generation, graph.nodes.len())
    });
    assert_eq!(held, 2);
    let persisted: Vec<_> = rows.iter().filter(|r| r.get("event").is_some_and(|e| e == "persist")).collect();
    assert_eq!(persisted.len(), 1, "{rows:?}");
    assert_eq!(persisted[0]["generation"], generation.to_string());
    assert!(persisted[0]["root"].contains("proj"), "{:?}", persisted[0]);
    assert!(rows.iter().all(|r| !r.contains_key("persist_ms") || r.get("event").is_some_and(|e| e == "persist")), "no per-call persist time");
}
/// A call that is refused still emits its row, with a request id and its outcome, and the row's stages sum to its total.
#[test]
fn a_refused_call_still_emits_its_row() {
    let (_tmp, root) = project_with_sentinel();
    let dir = tempfile::tempdir().unwrap();
    let tool = tool_over(&dir, NoTrust);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let (outcome, rows) =
        capturing(|| runtime.block_on(async { tool.answer(root.clone(), &serde_json::json!({ "mode": "nope" }), &mixdog_rt::CancellationToken::new()).await }));
    assert!(outcome.is_err());
    let calls: Vec<_> = rows.iter().filter(|r| r.get("event").is_some_and(|e| e == "call")).collect();
    assert_eq!(calls.len(), 1, "{rows:?}");
    assert_eq!(calls[0]["outcome"], "refused");
    assert!(calls[0]["request"].parse::<u64>().unwrap() >= 1);
    let ms = |key: &str| calls[0][key].parse::<u64>().unwrap();
    let staged = ms("queue_ms")
        + ms("query_ms")
        + ms("root_wait_ms")
        + ms("inventory_ms")
        + ms("cache_load_ms")
        + ms("parse_ms")
        + ms("link_ms")
        + ms("assemble_ms")
        + ms("admission_ms")
        + ms("prune_ms")
        + ms("wrap_ms")
        + ms("other_ms");
    assert_eq!(staged, ms("total_ms"), "every millisecond is in a stage or labelled other: {:?}", calls[0]);
}

/// The `code_graph` tool over a host that answers in this process, its cache in `dir`.
fn tool_over(dir: &tempfile::TempDir, trust: impl super::TrustedRoots + 'static) -> super::CodeGraphTool {
    super::CodeGraphTool::new(std::sync::Arc::new(trust), std::sync::Arc::new(super::testing::InProcessHost::new(dir.path().join("cache"))))
}

/// [`tool_over`] with the helper's output budget at `budget` bytes.
fn tool_budgeted(dir: &tempfile::TempDir, budget: usize) -> super::CodeGraphTool {
    let mut engine = super::engine::GraphEngine::new(dir.path().join("cache")).unwrap();
    engine.output_budget = Some(budget);
    super::CodeGraphTool::new(std::sync::Arc::new(NoTrust), std::sync::Arc::new(super::testing::InProcessHost::of(engine)))
}

fn tool_context(root: &Path) -> mixdog_core_api::domain::tool::ToolContext {
    use mixdog_core_api::domain::common::AbsPath;
    let tokens = mixdog_rt::testing::tokens();
    mixdog_core_api::domain::tool::ToolContext {
        call_id: mixdog_protocol::ToolCallId::from("c"),
        thread_id: mixdog_protocol::ThreadId::from("t"),
        turn_id: mixdog_protocol::TurnId::from("r"),
        tool: "code_graph".into(),
        cwd: AbsPath::new(root).unwrap(),
        surface: mixdog_core_api::domain::tool::SurfaceKind::Lead,
        cancel: tokio_util::sync::CancellationToken::new(),
        deadline: None,
        progress: std::sync::Arc::new(mixdog_core_api::domain::mock::MockProgress::default()),
        io: mixdog_core_api::domain::tool::ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: std::sync::Arc::new(mixdog_core_api::domain::mock::MockApprovalGate::default()),
        files: std::sync::Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
        processes: std::sync::Arc::new(mixdog_core_api::domain::mock::MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

#[tokio::test]
async fn a_callers_page_can_be_continued_with_the_published_page_argument() {
    use mixdog_core_api::domain::tool::{Tool, ToolPart};

    let (_tmp, root) = reader_project();
    fs::write(root.join("src/user.mjs"), "import { target } from './lib.mjs';\nexport function go() { target(); }\nexport function again() { target(); }\n")
        .unwrap();
    let cache_dir = tempfile::tempdir().unwrap();
    let tool = tool_over(&cache_dir, NoTrust);
    let schema = tool.definition();
    let page = &schema["inputSchema"]["properties"]["page"];
    assert_eq!(page["type"], "integer");
    assert_eq!(page["minimum"], 1);
    let ctx = tool_context(&root);
    let mut input = serde_json::json!({ "mode": "callers", "symbols": ["target"], "files": ["src/lib.mjs"], "depth": 2, "limit": 1 });
    let text = |out: mixdog_core_api::domain::tool::ToolOutput| {
        let [ToolPart::Text(text)] = out.parts.as_slice() else { panic!("{out:?}") };
        text.to_owned()
    };
    let first = text(tool.call(&ctx, input.clone()).await.unwrap());
    let next = first.lines().find(|line| line.starts_with("# NEXT")).expect("the first page advertises a continuation");
    let (_, rest) = next.split_once("keep the same callers arguments and set page:").expect("the hint preserves scope and page size");
    let (page, _) = rest.split_once(' ').unwrap();
    assert_eq!(page, "2");
    input["page"] = serde_json::json!(page.parse::<u64>().unwrap());
    let second = text(tool.call(&ctx, input.clone()).await.unwrap());
    assert!(first.contains("nodes 1-1 of 2") && second.contains("nodes 2-2 of 2"), "{first}\n{second}");
    let sites = |body: &str| body.lines().filter(|line| line.contains("\tsrc/user.mjs:")).map(|line| line.trim().to_owned()).collect::<Vec<_>>();
    let (first_sites, second_sites) = (sites(&first), sites(&second));
    assert_eq!((first_sites.len(), second_sites.len()), (1, 1));
    let mut all = [first_sites[0].as_str(), second_sites[0].as_str()];
    all.sort_unstable();
    assert_eq!(all, ["again\tsrc/user.mjs:3", "go\tsrc/user.mjs:2"]);
    assert!(second.contains("# END") && !second.contains("# NEXT"), "{second}");
    input["page"] = serde_json::json!(u64::MAX);
    input["limit"] = serde_json::json!(3);
    let past_end = text(tool.call(&ctx, input).await.unwrap());
    assert!(past_end.contains("is past the end (total 2 node(s); last page is 1)"), "{past_end}");
}

#[tokio::test]
async fn a_byte_capped_graph_result_delivers_whole_rows_and_marks_the_tool_result_incomplete() {
    use mixdog_core_api::domain::tool::{Tool, ToolPart};

    let (_tmp, root) = project_with_sentinel();
    let source: String = (0..12).map(|i| format!("export function named_symbol_{i:02}(parameter) {{ return parameter; }}\n")).collect();
    fs::write(root.join("src/outline.mjs"), source).unwrap();
    let (wide_dir, narrow_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let ctx = tool_context(&root);
    let input = serde_json::json!({ "mode": "symbols", "files": ["src/outline.mjs"] });
    let whole = tool_budgeted(&wide_dir, 4_096).call(&ctx, input.clone()).await.unwrap();
    assert_eq!(whole.meta.unwrap()[super::COMPLETE_META], true);
    let capped = tool_budgeted(&narrow_dir, 400).call(&ctx, input).await.unwrap();
    assert_eq!(capped.meta.unwrap()[super::COMPLETE_META], false);
    let ([ToolPart::Text(full)], [ToolPart::Text(short)]) = (whole.parts.as_slice(), capped.parts.as_slice()) else { panic!("expected text answers") };
    let (rows, footer) = short.rsplit_once('\n').unwrap();
    assert!(short.len() <= 400);
    assert!(rows.contains("named_symbol_00") && !rows.contains("named_symbol_11"), "{short}");
    assert!(rows.lines().eq(full.lines().take(rows.lines().count())), "{short}");
    assert!(footer.contains("remainder for file=\"src/outline.mjs\" omitted"), "{footer}");
}

/// One row per public call, whatever its outcome, through `call` itself.
#[test]
fn every_public_call_emits_one_row_refusals_included() {
    use mixdog_core_api::domain::tool::Tool;
    let (_tmp, root) = project_with_sentinel();
    let dir = tempfile::tempdir().unwrap();
    let tool = tool_over(&dir, NoTrust);
    let ctx = tool_context(&root);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let cases = [
        (serde_json::json!({ "mode": "nope" }), "nope", "refused", true),
        (serde_json::json!({ "symbol": "a" }), "", "refused", true),
        (serde_json::Value::Null, "", "refused", true),
        (serde_json::json!({ "mode": "overview" }), "overview", "ok", false),
        // Accepted, and returned before the host: its row; the background warm it schedules is not a call and has none.
        (serde_json::json!({ "mode": "prewarm" }), "prewarm", "ok", false),
    ];
    for (args, mode, outcome, refused) in cases {
        let (result, rows) = capturing(|| runtime.block_on(tool.call(&ctx, args.clone())));
        assert_eq!(result.is_err(), refused, "{args}");
        let calls: Vec<_> = rows.iter().filter(|r| r.get("event").is_some_and(|e| e == "call")).collect();
        assert_eq!(calls.len(), 1, "{args}: {rows:?}");
        assert_eq!((calls[0]["mode"].as_str(), calls[0]["outcome"].as_str()), (mode, outcome), "{args}");
        assert!(calls[0]["request"].parse::<u64>().unwrap() >= 1);
        let ms = |key: &str| calls[0][key].parse::<u64>().unwrap();
        if refused || mode == "prewarm" {
            assert_eq!(ms("other_ms"), ms("total_ms"), "a refusal before the lane is all unattributed time: {:?}", calls[0]);
        }
    }
}
/// Forgetting a root removes its refresh lock and the ledger entries under it, and no other root's.
#[test]
fn forgetting_a_root_removes_its_lock_and_ledger_entries() {
    let (_t1, one) = project_with_sentinel();
    let (_t2, two) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    cache.graph(&one, &[]).unwrap();
    cache.graph(&two, &[]).unwrap();
    let (a, b) = (one.join("a.txt"), two.join("b.txt"));
    std::fs::write(&a, "x").unwrap();
    std::fs::write(&b, "x").unwrap();
    cache.note_resolved(&[a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()]);
    assert_eq!((cache.tracked_roots(), cache.ledger_len()), (2, 2));
    cache.graph(&one, &[two.clone()]).unwrap();
    assert_eq!(cache.tracked_roots(), 3, "the scoped build of a root has its own lock");
    cache.forget(&one);
    assert_eq!((cache.tracked_roots(), cache.ledger_len()), (1, 1), "the root's lock, scoped locks and ledger paths are gone");
}

/// A refresh that waits for a root's turn while the root is forgotten keeps that turn: the root's next caller queues on the same
/// one, so the root's refresh stays single-flight. A turn nothing holds goes with its root.
#[test]
fn a_root_forgotten_while_a_refresh_waits_keeps_its_turn() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();
    cache.graph(&root, &[]).unwrap();
    let waiting = cache.hold_root(&root);
    cache.forget(&root);
    assert!(std::sync::Arc::ptr_eq(&waiting, &cache.hold_root(&root)), "the next caller queues behind the waiting refresh");
    drop(waiting);
    cache.forget(&root);
    assert_eq!(cache.tracked_roots(), 0);
}

#[test]
fn file_scoped_find_symbol_and_multi_file_symbols_do_not_walk_the_project() {
    let (_tmp, root) = project_with_sentinel();
    fs::write(root.join("src/c.mjs"), "export function c_fn() { return 3; }\n").unwrap();
    fs::write(root.join("src/other.mjs"), "export function unrelated() { return 4; }\n").unwrap();
    let (_dir, cache) = no_cache();
    let inv_before = super::graph::INVENTORIES.with(std::cell::Cell::get);
    let parsed_before = parsed();

    let single = ask(&cache, &root, serde_json::json!({ "mode": "symbols", "file": "src/a.mjs" }));
    assert!(single.complete && single.text.contains("a (L1)"), "{}", single.text);
    assert_eq!(super::graph::INVENTORIES.with(std::cell::Cell::get) - inv_before, 0);
    assert_eq!(parsed() - parsed_before, 1);

    let multi = ask(&cache, &root, serde_json::json!({ "mode": "symbols", "files": ["src/a.mjs", "src/b.mjs", "src/c.mjs"] }));
    assert!(multi.complete && multi.text.contains("c_fn"), "{}", multi.text);
    assert_eq!(super::graph::INVENTORIES.with(std::cell::Cell::get) - inv_before, 0, "multi-file symbols must not walk the project");
    assert_eq!(parsed() - parsed_before, 4, "only the three requested files were parsed");

    let scoped_find = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "file": "src/c.mjs", "symbol": "c_fn" }));
    assert!(scoped_find.complete && scoped_find.text.contains("export function c_fn()"), "{}", scoped_find.text);
    assert_eq!(super::graph::INVENTORIES.with(std::cell::Cell::get) - inv_before, 0, "file-scoped find_symbol must not walk the project");
    assert_eq!(parsed() - parsed_before, 5, "only the requested file was parsed");
    assert_eq!(cache.builds(), 0);
    assert!(cache.held_roots().is_empty());
}

#[test]
fn unscoped_query_on_loaded_graph_does_not_read_and_hash_every_source_file() {
    let (_tmp, root) = project_with_sentinel();
    for i in 0..20 {
        fs::write(root.join(format!("src/f{i:02}.mjs")), format!("export function fn_{i:02}() {{ return {i}; }}\n")).unwrap();
    }
    let (_dir, cache) = no_cache();
    cache.graph(&root, &[]).unwrap();
    assert_eq!(cache.builds(), 1);

    let verified_before = super::graph::VERIFIED_READS.with(std::cell::Cell::get);
    let parsed_before = parsed();
    let overview = ask(&cache, &root, serde_json::json!({ "mode": "overview" }));
    assert!(overview.complete && overview.text.contains("files\t22"), "{}", overview.text);
    assert_eq!(super::graph::VERIFIED_READS.with(std::cell::Cell::get) - verified_before, 0, "overview must not hash source files");
    assert_eq!(parsed() - parsed_before, 0);

    let search = ask(&cache, &root, serde_json::json!({ "mode": "symbol_search", "symbol": "fn_07" }));
    assert!(search.complete && search.text.contains("fn_07"), "{}", search.text);
    assert_eq!(super::graph::VERIFIED_READS.with(std::cell::Cell::get) - verified_before, 0, "symbol_search must not hash source files");

    let found = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "fn_07" }));
    assert!(found.complete && found.text.contains("export function fn_07()"), "{}", found.text);
    let reads = super::graph::VERIFIED_READS.with(std::cell::Cell::get) - verified_before;
    assert!(reads <= 3, "find_symbol should read only the matched file, not all 22 files (got {reads})");
    assert_eq!(cache.builds(), 1, "loaded graph was reused without rebuilding");
}

#[test]
fn a_file_changing_during_a_call_reparses_only_that_file_without_failing() {
    let (_tmp, root) = project_with_sentinel();
    fs::write(root.join("src/c.mjs"), "export const c = 3;\n").unwrap();
    let (_dir, cache) = no_cache();
    cache.graph(&root, &[]).unwrap();

    // Same-stamp rewrite while the graph is already loaded: reconcile reuses the graph,
    // references detects the digest mismatch when reading src/b.mjs, and re-parses only src/b.mjs.
    let edited = "import { a } from './a.mjs';\nexport const z = a;\n";
    same_size_rewrite(&root.join("src/b.mjs"), edited);
    let inv_before = super::graph::INVENTORIES.with(std::cell::Cell::get);
    let parsed_before = parsed();
    let answer = ask(&cache, &root, serde_json::json!({ "mode": "references", "symbol": "a" }));
    assert!(answer.complete && answer.text.contains("export const z = a;"), "{}", answer.text);
    assert_eq!(super::graph::INVENTORIES.with(std::cell::Cell::get) - inv_before, 1, "re-parsing the stale file must not re-walk the project");
    assert_eq!(parsed() - parsed_before, 1, "only the changed file was re-parsed");

    // A file changing between the file-scoped build and body read re-parses only that file and succeeds.
    let inv_before = super::graph::INVENTORIES.with(std::cell::Cell::get);
    super::graph::FORCED_MISMATCHES.with(|n| n.set(1));
    let scoped = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "file": "src/a.mjs", "symbol": "a" }));
    assert!(scoped.complete && scoped.text.contains("export const a = 1;"), "{}", scoped.text);
    assert_eq!(super::graph::INVENTORIES.with(std::cell::Cell::get) - inv_before, 0, "file-scoped re-parse must not walk the project");

    // A file mutating mid-read during single-file symbols is omitted as unverified instead of failing with "run it again".
    grow_while_read(root.join("src/a.mjs"), false);
    let unstable = ask(&cache, &root, serde_json::json!({ "mode": "symbols", "file": "src/a.mjs" }));
    stop_growing();
    assert!(!unstable.complete && unstable.text.contains("changed while it was being read"), "{}", unstable.text);
}

#[test]
fn file_scoped_find_symbol_and_search_preserve_full_graph_answers_when_scope_does_not_suffice() {
    let (_tmp, root) = project_with_sentinel();
    let (_dir, cache) = no_cache();

    // `a` is imported in `src/b.mjs` and declared in `src/a.mjs`: must report the outside declaration, not "global/builtin".
    let imported = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "a", "file": "src/b.mjs" }));
    assert!(imported.complete, "{}", imported.text);
    assert!(imported.text.contains("declared outside the requested files: src/a.mjs:1"), "{}", imported.text);
    assert!(!imported.text.contains("likely a global/builtin"), "{}", imported.text);

    // No-match find_symbol and symbol_search must report the real project node count, not `nodes=1`.
    let missing_find = ask(&cache, &root, serde_json::json!({ "mode": "find_symbol", "symbol": "nonexistent", "file": "src/a.mjs" }));
    assert!(missing_find.text.contains("graph: nodes=2"), "{}", missing_find.text);
    let missing_search = ask(&cache, &root, serde_json::json!({ "mode": "symbol_search", "symbol": "nonexistent", "file": "src/a.mjs" }));
    assert!(missing_search.text.contains("graph: nodes=2"), "{}", missing_search.text);

    // When `symbol_search` matches in the requested file, it avoids walking the project.
    let (_dir2, fresh_cache) = no_cache();
    let inv_before = super::graph::INVENTORIES.with(std::cell::Cell::get);
    let hit_search = ask(&fresh_cache, &root, serde_json::json!({ "mode": "symbol_search", "symbol": "a", "file": "src/a.mjs" }));
    assert!(hit_search.complete && hit_search.text.contains("src/a.mjs:1"), "{}", hit_search.text);
    assert_eq!(super::graph::INVENTORIES.with(std::cell::Cell::get) - inv_before, 0);
}

#[test]
fn manifest_changes_during_a_call_relink_once_and_disclose_continued_changes_without_spinning() {
    let (_tmp, root) = project_with_sentinel();
    for (rel, text) in [
        ("tsconfig.json", r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/a/*"]}}}"#),
        ("src/use.ts", "import { x } from '@lib/x';\nexport const y = x;\n"),
        ("src/a/x.ts", "export const x = 1;\n"),
        ("src/b/x.ts", "export const x = 2;\n"),
    ] {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let (_dir, cache) = no_cache();
    let imports_query = serde_json::json!({ "mode": "imports", "file": "src/use.ts" });
    assert_eq!(ask(&cache, &root, imports_query.clone()).text.lines().next(), Some("src/a/x.ts"));

    // 1) Manifest changes once while the query runs: relinks once and serves fresh, complete edges.
    let tsconfig = root.join("tsconfig.json");
    let mut checks = 0usize;
    super::graph::BEFORE_RESOLVER_CHECK.with(|hook| {
        let tsconfig = tsconfig.clone();
        *hook.borrow_mut() = Some(Box::new(move || {
            checks += 1;
            // Check 1 is inside `reconcile` (`is_fresh`); check 2 is after `answer_sections`.
            if checks == 2 {
                fs::write(&tsconfig, r#"{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/b/*"]}}}"#).unwrap();
            }
        }));
    });
    let relinked = ask(&cache, &root, imports_query.clone());
    super::graph::BEFORE_RESOLVER_CHECK.with(|hook| *hook.borrow_mut() = None);
    assert!(relinked.complete && relinked.warnings.is_empty(), "{}", relinked.text);
    assert_eq!(relinked.text.lines().next(), Some("src/b/x.ts"));

    // 2) Manifest keeps changing after the relink with nothing else stale: terminates and discloses warning.
    let mut seq = 0usize;
    super::graph::BEFORE_RESOLVER_CHECK.with(|hook| {
        let tsconfig = tsconfig.clone();
        *hook.borrow_mut() = Some(Box::new(move || {
            seq += 1;
            if seq >= 2 {
                let target = if seq % 2 == 0 { "src/a/*" } else { "src/b/*" };
                fs::write(&tsconfig, format!(r#"{{"compilerOptions":{{"baseUrl":".","paths":{{"@lib/*":["{target}"]}}}}}} // {seq}"#)).unwrap();
            }
        }));
    });
    let manifest_only = ask(&cache, &root, imports_query.clone());
    super::graph::BEFORE_RESOLVER_CHECK.with(|hook| *hook.borrow_mut() = None);
    assert!(!manifest_only.complete && !manifest_only.warnings.is_empty(), "{}", manifest_only.text);
    let wrapped = super::output::wrap(manifest_only.text, &manifest_only.warnings, &Args::parse(&imports_query));
    assert!(wrapped.contains("[warning] graph incomplete:") && wrapped.contains("manifest(s) changed") && wrapped.contains("tsconfig.json"), "{wrapped}");

    // 3) Manifest keeps changing while a source file is also dropped into `unverified`: must not spin forever.
    let refs_query = serde_json::json!({ "mode": "references", "symbol": "x" });
    let mut seq2 = 0usize;
    super::graph::FORCED_MISMATCHES.with(|n| n.set(1000));
    super::graph::BEFORE_RESOLVER_CHECK.with(|hook| {
        let tsconfig = tsconfig.clone();
        *hook.borrow_mut() = Some(Box::new(move || {
            seq2 += 1;
            if seq2 >= 2 {
                let target = if seq2 % 2 == 0 { "src/a/*" } else { "src/b/*" };
                fs::write(&tsconfig, format!(r#"{{"compilerOptions":{{"baseUrl":".","paths":{{"@lib/*":["{target}"]}}}}}} // r{seq2}"#)).unwrap();
            }
        }));
    });
    let both = ask(&cache, &root, refs_query.clone());
    super::graph::BEFORE_RESOLVER_CHECK.with(|hook| *hook.borrow_mut() = None);
    super::graph::FORCED_MISMATCHES.with(|n| n.set(0));
    assert!(!both.complete && !both.warnings.is_empty(), "{}", both.text);
    let wrapped_both = super::output::wrap(both.text, &both.warnings, &Args::parse(&refs_query));
    assert!(wrapped_both.contains("file(s) changed while they were being read"), "{wrapped_both}");
    assert!(wrapped_both.contains("manifest(s) changed") && wrapped_both.contains("tsconfig.json"), "{wrapped_both}");
}

// ---- the engine a graph worker hosts ----

fn engine_in(dir: &tempfile::TempDir) -> super::engine::GraphEngine {
    super::engine::GraphEngine::new(dir.path().join("cache")).unwrap()
}

/// A call as the core sends it: its arguments past the argument guard.
fn engine_query(engine: &super::engine::GraphEngine, cwd: &Path, args: Value, registered: &[std::path::PathBuf]) -> Result<super::engine::Rendered, String> {
    engine.query(cwd, &super::guard_args(args).unwrap(), registered.to_vec(), Vec::new())
}

fn ask_engine(engine: &super::engine::GraphEngine, cwd: &Path, args: Value) -> super::engine::Rendered {
    engine_query(engine, cwd, args, &[]).unwrap()
}

fn lossy(roots: Option<Vec<std::path::PathBuf>>) -> Option<Vec<String>> {
    roots.map(|roots| roots.iter().map(|root| root.to_string_lossy().into_owned()).collect())
}

struct Registered(Vec<std::path::PathBuf>);

#[async_trait::async_trait]
impl super::TrustedRoots for Registered {
    async fn registered(&self) -> Vec<std::path::PathBuf> {
        self.0.clone()
    }

    async fn selected(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }
}

/// An answer as a caller sees it: the text, the dependency roots (`None`: none recorded) and, with roots, whether it is whole;
/// or the refusal's message.
type Seen = Result<(String, Option<Vec<String>>, Option<bool>), String>;

async fn seen_by_tool(tool: &super::CodeGraphTool, cwd: &Path, args: Value) -> Seen {
    use mixdog_core_api::domain::tool::{Tool, ToolPart};
    match tool.call(&tool_context(cwd), args).await {
        Ok(output) => {
            let [ToolPart::Text(text)] = output.parts.as_slice() else { panic!("{output:?}") };
            let meta = output.meta.unwrap_or_default();
            let roots = meta.get(super::DEPENDENCY_ROOTS_META).map(|roots| serde_json::from_value(roots.clone()).unwrap());
            Ok((text.clone(), roots, meta.get(super::COMPLETE_META).and_then(Value::as_bool)))
        }
        Err(error) => Err(error.message_for_model),
    }
}

fn seen_by_engine(engine: &super::engine::GraphEngine, cwd: &Path, args: Value, registered: &[std::path::PathBuf]) -> Seen {
    engine_query(engine, cwd, args, registered).map(|answer| {
        let complete = answer.dependency_roots.is_some().then_some(answer.complete);
        (answer.text, lossy(answer.dependency_roots), complete)
    })
}

/// What the tool answers `args` with, and what the engine answers the same call with.
async fn tool_and_engine(
    tool: &super::CodeGraphTool,
    engine: &super::engine::GraphEngine,
    cwd: &Path,
    args: Value,
    registered: &[std::path::PathBuf],
) -> (Seen, Seen) {
    (seen_by_tool(tool, cwd, args.clone()).await, seen_by_engine(engine, cwd, args, registered))
}

/// The engine answers every mode with the tool's bytes: fan-outs, pagination, an answer that records no roots and the
/// dispatcher's refusal included.
#[tokio::test]
async fn the_engine_answers_each_mode_with_the_tools_text_roots_and_completeness() {
    let (_tmp, root) = reader_project();
    let (tool_dir, engine_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let tool = tool_over(&tool_dir, NoTrust);
    let engine = engine_in(&engine_dir);
    let calls = [
        serde_json::json!({ "mode": "overview" }),
        serde_json::json!({ "mode": "imports", "file": "src/user.mjs" }),
        serde_json::json!({ "mode": "dependents", "file": "src/lib.mjs" }),
        serde_json::json!({ "mode": "related", "file": "src/lib.mjs" }),
        serde_json::json!({ "mode": "impact", "file": "src/lib.mjs" }),
        serde_json::json!({ "mode": "symbols", "files": ["src/lib.mjs", "src/user.mjs"] }),
        serde_json::json!({ "mode": "find_symbol", "symbols": ["target", "lonely"] }),
        serde_json::json!({ "mode": "symbol_search", "symbol": "targ" }),
        serde_json::json!({ "mode": "references", "symbol": "target" }),
        serde_json::json!({ "mode": "callers", "symbol": "target" }),
        serde_json::json!({ "mode": "callers", "symbols": ["target"], "files": ["src/lib.mjs"], "depth": 2, "limit": 1 }),
        serde_json::json!({ "mode": "callees", "symbol": "go", "file": "src/user.mjs" }),
    ];
    for args in calls {
        let (by_tool, by_engine) = tool_and_engine(&tool, &engine, &root, args.clone(), &[]).await;
        assert!(by_tool.as_ref().is_ok_and(|(_, roots, _)| roots.is_some()), "{args}: {by_tool:?}");
        assert_eq!(by_engine, by_tool, "{args}");
    }
    let (by_tool, by_engine) = tool_and_engine(&tool, &engine, &root, serde_json::json!({ "mode": "imports", "file": "src/nope.mjs" }), &[]).await;
    assert!(by_tool.as_ref().is_ok_and(|(_, roots, _)| roots.is_none()), "a missing file records no roots: {by_tool:?}");
    assert_eq!(by_engine, by_tool);
    let (by_tool, by_engine) = tool_and_engine(&tool, &engine, &root, serde_json::json!({ "mode": "symbols", "node_offset": 5 }), &[]).await;
    assert!(by_tool.as_ref().is_err_and(|message| message.starts_with("code_graph: node_offset requires")), "{by_tool:?}");
    assert_eq!(by_engine, by_tool);
}

/// A folder holding two registered projects: the engine, told the registered roots, federates exactly as the tool does.
#[tokio::test]
async fn a_federated_answer_from_the_engine_is_the_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let multi = tmp.path().join("multi");
    for (name, rel, text) in
        [("alpha", "src/a.mjs", "export function shared() {\n  return 1;\n}\n"), ("beta", "lib/b.mjs", "export function shared() {\n  return 2;\n}\n")]
    {
        fs::create_dir_all(multi.join(name).join(rel).parent().unwrap()).unwrap();
        fs::write(multi.join(name).join("package.json"), "{}").unwrap();
        fs::write(multi.join(name).join(rel), text).unwrap();
    }
    let multi = multi.canonicalize().unwrap();
    let registered = vec![multi.join("alpha"), multi.join("beta")];
    let (tool_dir, engine_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let tool = tool_over(&tool_dir, Registered(registered.clone()));
    let engine = engine_in(&engine_dir);
    for args in [serde_json::json!({ "mode": "find_symbol", "symbols": "shared" }), serde_json::json!({ "mode": "overview" })] {
        let (by_tool, by_engine) = tool_and_engine(&tool, &engine, &multi, args.clone(), &registered).await;
        assert!(by_tool.as_ref().is_ok_and(|(text, _, _)| text.contains("# project alpha [") && text.contains("# project beta [")), "{args}: {by_tool:?}");
        assert_eq!(by_engine, by_tool, "{args}");
    }
}

/// The output budget cuts the engine's answer where it cuts the tool's, and the cut answer is partial.
#[tokio::test]
async fn a_byte_capped_answer_from_the_engine_is_the_tools_and_is_partial() {
    let (_tmp, root) = project_with_sentinel();
    let source: String = (0..12).map(|i| format!("export function named_symbol_{i:02}(parameter) {{ return parameter; }}\n")).collect();
    fs::write(root.join("src/outline.mjs"), source).unwrap();
    let (tool_dir, engine_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let tool = tool_budgeted(&tool_dir, 400);
    let mut engine = engine_in(&engine_dir);
    engine.output_budget = Some(400);
    let (by_tool, by_engine) = tool_and_engine(&tool, &engine, &root, serde_json::json!({ "mode": "symbols", "files": ["src/outline.mjs"] }), &[]).await;
    assert!(by_tool.as_ref().is_ok_and(|(_, _, complete)| *complete == Some(false)), "{by_tool:?}");
    assert_eq!(by_engine, by_tool);
}

/// A same-stamp rewrite made while no worker ran: the next worker's disk copy has the old record at the very stamp the file
/// has now and no notice of the write, so a query that reads no source (one naming only a symbol) is right only because the
/// record is verified against its digest. The file whose bytes still match is reused, not parsed.
#[test]
fn a_same_stamp_edit_between_two_workers_is_seen_by_a_symbol_only_query() {
    let (_tmp, root) = calls_project();
    let dir = tempfile::tempdir().unwrap();
    let first = engine_in(&dir);
    let old = ask_engine(&first, &root, serde_json::json!({ "mode": "find_symbol", "symbols": "f" }));
    assert!(old.text.contains("src/c.mjs:1"), "{}", old.text);
    first.drain().unwrap();
    drop(first);
    same_size_rewrite(&root.join("src/c.mjs"), "export function q() { return h(); }\n");
    let next = engine_in(&dir);
    let found = ask_engine(&next, &root, serde_json::json!({ "mode": "find_symbol", "symbols": "q" }));
    assert!(found.text.contains("src/c.mjs:1") && found.text.contains("export function q() { return h(); }"), "{}", found.text);
    let graph = found.timings.graph;
    assert_eq!((graph.parsed, graph.reused, graph.verified), (1, 1, 2), "the changed record is parsed, the matching one reused: {graph:?}");
}

/// Inside one lifetime the disk copy is reused by its stamps and receipts: nothing is read to verify it.
#[test]
fn a_disk_copy_of_this_lifetime_is_reused_without_reading_its_sources() {
    let (_tmp, root) = calls_project();
    let (_dir, cache) = no_cache();
    drop(cache.graph(&root, &[]).unwrap());
    cache.flush().unwrap();
    cache.evict_all();
    let _ = super::cache::take_timings();
    cache.graph(&root, &[]).unwrap();
    let spent = super::cache::take_timings();
    assert_eq!((spent.parsed, spent.reused, spent.verified), (0, 2, 0), "{spent:?}");
}

/// No timer releases what the engine holds: a graph stays until its worker exits, and a drain first writes what is staged.
/// The successor starts from that disk copy and answers alike without parsing.
#[test]
fn a_held_graph_leaves_with_its_engine_and_the_successor_answers_from_the_drained_copy() {
    let (_tmp, root) = reader_project();
    let dir = tempfile::tempdir().unwrap();
    let engine = engine_in(&dir);
    let args = serde_json::json!({ "mode": "callers", "symbol": "target" });
    let first = ask_engine(&engine, &root, args.clone());
    let again = ask_engine(&engine, &root, args.clone());
    assert_eq!(engine.cache().builds(), 1, "taking the held generation again builds nothing");
    assert_eq!(again.timings.graph.retained, Some(true));
    engine.drain().unwrap();
    drop(engine);
    let files = super::GraphCache::new(dir.path().join("cache")).load(&root).map(|files| files.len());
    assert_eq!(files, Some(5), "the drain wrote every indexed file");
    let next = engine_in(&dir);
    let answer = ask_engine(&next, &root, args);
    assert_eq!((answer.timings.graph.parsed, answer.timings.graph.reused), (0, 5), "{:?}", answer.timings.graph);
    assert_eq!((answer.text, answer.dependency_roots, answer.complete), (first.text, first.dependency_roots, first.complete));
}

/// A write that failed (the debounce runs this same flush) leaves its graph staged: the drain after it writes the graph again and
/// fails with it, instead of acknowledging a graph that never reached the disk, and writes it once it can.
#[test]
fn a_drain_after_a_failed_write_reports_it_and_writes_the_graph_once_it_can() {
    let (_tmp, root) = project_with_sentinel();
    let dir = tempfile::tempdir().unwrap();
    // A file where the cache directory goes: no write stores anything.
    let blocker = dir.path().join("cache");
    fs::write(&blocker, "").unwrap();
    let engine = engine_in(&dir);
    ask_engine(&engine, &root, serde_json::json!({ "mode": "overview" }));
    assert!(engine.cache().flush().is_err(), "the write fails");
    assert!(engine.drain().is_err(), "the drain finds the graph still staged and cannot write it either");
    fs::remove_file(&blocker).unwrap();
    engine.drain().unwrap();
    assert_eq!(super::GraphCache::new(blocker).load(&root).map(|files| files.len()), Some(2), "the drain wrote the graph");
}

/// Through the worker's handler: a write notice resolved when the write was made reaches the next query, a same-stamp rewrite
/// included; a change at an unknown location makes every file of the root parsed again once; a refusal is the dispatcher's.
#[test]
fn change_notices_reach_the_next_query() {
    use mixdog_graph_host::wire;
    use mixdog_graph_host::worker::{Handler, Rejection};
    let (_tmp, root) = calls_project();
    let dir = tempfile::tempdir().unwrap();
    let worker = super::engine::Worker(engine_in(&dir));
    let ask = |args: Value| {
        Handler::query(&worker, wire::Query { session_cwd: root.clone(), args: super::guard_args(args).unwrap(), registered: Vec::new(), selected: Vec::new() })
    };
    ask(serde_json::json!({ "mode": "find_symbol", "symbols": "f" })).unwrap();
    let path = root.join("src/c.mjs");
    same_size_rewrite(&path, "export function q() { return h(); }\n");
    let identity = super::engine::change_identities(&[path.to_string_lossy().into_owned()]).remove(0).unwrap();
    Handler::changed(&worker, wire::Changed { files: vec![wire::FileIdentity::Known { identity }] });
    let seen = ask(serde_json::json!({ "mode": "find_symbol", "symbols": "q" })).unwrap();
    assert!(seen.text.contains("src/c.mjs:1"), "{}", seen.text);
    assert_eq!(seen.timings.files_parsed, 1, "only the noticed file is parsed");
    Handler::changed(&worker, wire::Changed { files: vec![wire::FileIdentity::Unknown] });
    assert_eq!(ask(serde_json::json!({ "mode": "overview" })).unwrap().timings.files_parsed, 2, "a change at an unknown location reparses every file");
    let refused = ask(serde_json::json!({ "mode": "symbols", "node_offset": 5 }));
    assert!(matches!(&refused, Err(Rejection::Refused(refusal)) if refusal.message.starts_with("code_graph: node_offset requires")), "{refused:?}");
}

/// A writer the serve loop's replies are collected in.
#[derive(Clone, Default)]
struct Sink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The worker's serve loop over the engine: a query answered with the tool's text and roots (as paths), then a drain that
/// writes the graph before it is acknowledged.
#[tokio::test]
async fn the_worker_serves_the_tools_answer_and_drains_before_it_acknowledges() {
    use mixdog_graph_host::{frame, wire, worker};
    let (_tmp, root) = reader_project();
    let args = serde_json::json!({ "mode": "find_symbol", "symbols": "target" });
    let tool_dir = tempfile::tempdir().unwrap();
    let tool = tool_over(&tool_dir, NoTrust);
    let by_tool = seen_by_tool(&tool, &root, args.clone()).await;
    let query = wire::Query { session_cwd: root.clone(), args: super::guard_args(args).unwrap(), registered: Vec::new(), selected: Vec::new() };
    let mut input = Vec::new();
    for message in [wire::ToWorker::Query { id: 1, query }, wire::ToWorker::DrainAndExit { id: 2 }] {
        input.extend(frame::encode(&message).unwrap());
    }
    let dir = tempfile::tempdir().unwrap();
    let output = Sink::default();
    let handler = std::sync::Arc::new(super::engine::Worker(engine_in(&dir)));
    assert_eq!(worker::serve(handler, input.as_slice(), output.clone()), worker::EXIT_DONE);
    let written = output.0.lock().unwrap().clone();
    let mut reader = frame::FrameReader::new(written.as_slice());
    let mut replies = Vec::new();
    while let Some(message) = reader.read::<wire::FromWorker>().unwrap() {
        replies.push(message);
    }
    let [
        wire::FromWorker::Ready { .. },
        wire::FromWorker::Reply { id: 1, reply: wire::Reply::Answer { answer } },
        wire::FromWorker::Reply { id: 2, reply: wire::Reply::DrainAck { ack } },
    ] = replies.as_slice()
    else {
        panic!("{replies:?}")
    };
    assert_eq!(Ok((answer.text.clone(), lossy(answer.dependency_roots.clone()), Some(answer.complete))), by_tool);
    assert_eq!(answer.timings.files_parsed, 5);
    assert_eq!(ack.failure, None);
    assert_eq!(super::GraphCache::new(dir.path().join("cache")).load(&root).map(|files| files.len()), Some(5), "the drain wrote the graph");
}

/// A warm fills the engine's own graph: the query after it builds nothing; a folder that is no project warms nothing.
#[test]
fn a_prewarm_fills_the_engines_graph() {
    let (_tmp, root) = project_with_sentinel();
    let dir = tempfile::tempdir().unwrap();
    let first = engine_in(&dir);
    ask_engine(&first, &root, serde_json::json!({ "mode": "overview" }));
    first.drain().unwrap();
    drop(first);
    let engine = engine_in(&dir);
    assert!(engine.prewarm(&root.join("src")));
    let answer = ask_engine(&engine, &root, serde_json::json!({ "mode": "overview" }));
    assert_eq!((engine.cache().builds(), answer.timings.graph.retained), (1, Some(true)), "the query took the warmed generation");
    assert!(!engine.prewarm(tempfile::tempdir().unwrap().path()));
}

/// A removed worktree's root goes from the engine and from disk; another root keeps its own.
#[test]
fn forgetting_a_root_through_the_engine_removes_its_disk_copy_only() {
    let (_t1, gone) = project_with_sentinel();
    let (_t2, stays) = project_with_sentinel();
    let dir = tempfile::tempdir().unwrap();
    let engine = engine_in(&dir);
    for root in [&gone, &stays] {
        ask_engine(&engine, root, serde_json::json!({ "mode": "overview" }));
    }
    engine.drain().unwrap();
    let (removed, kept) = engine.forget_root(&gone);
    assert!(kept.is_empty() && removed.iter().any(|name| name.starts_with("manifest:")), "{removed:?}");
    assert_eq!(super::GraphCache::new(dir.path().join("cache")).roots(), [stays.clone()]);
    let answer = ask_engine(&engine, &gone, serde_json::json!({ "mode": "overview" }));
    assert_eq!(answer.timings.graph.parsed, 2, "the forgotten root is built from nothing");
}

/// With no worker running, a removed root's manifest row, payload and heap note go through the disk catalog alone, and no
/// other root's; a cache directory that does not exist is not created.
#[test]
fn the_disk_catalog_forgets_a_root_without_a_graph_in_memory() {
    let (_t1, gone) = project_with_sentinel();
    let (_t2, stays) = project_with_sentinel();
    let (dir, cache) = no_cache();
    cache.graph(&gone, &[]).unwrap();
    cache.graph(&stays, &[]).unwrap();
    cache.flush().unwrap();
    drop(cache);
    let cache_dir = dir.path().join("cache");
    let (removed, kept) = super::engine::DiskCatalog::new(cache_dir.clone()).forget(&gone);
    assert!(kept.is_empty(), "{kept:?}");
    assert!(removed.iter().any(|name| name.starts_with("manifest:")) && removed.iter().any(|name| name.ends_with(".json")), "{removed:?}");
    let after = super::GraphCache::new(cache_dir.clone());
    assert_eq!(after.roots(), [stays.clone()]);
    assert!(after.load(&gone).is_none() && after.load(&stays).is_some());
    after.prewarm(&gone);
    assert_eq!(after.builds(), 0, "the forgotten root's weight is gone with it: a warm does not build it");
    after.prewarm(&stays);
    assert_eq!(after.builds(), 1, "the other root's weight stays");
    let missing = dir.path().join("never");
    assert_eq!(super::engine::DiskCatalog::new(missing.clone()).forget(&gone), (Vec::new(), Vec::new()));
    assert!(!missing.exists());
}
