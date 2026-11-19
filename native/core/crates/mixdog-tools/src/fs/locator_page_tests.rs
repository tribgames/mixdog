use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use mixdog_core_api::domain::fs::{DirEntry, EntryKind};
use mixdog_core_api::domain::tool::Tool;
use mixdog_workspace::localfs::LocalFileService;
use serde_json::json;

use super::{GlobTool, ListTool, tests::{StatControl, StatFails, context_seeded, small_dir, text_of}};

#[tokio::test]
async fn a_late_list_page_adds_metadata_without_changing_its_entries() {
    let (_dir, root) = small_dir();
    for (name, body) in [("d.txt", "D\n"), ("c.txt", "C\nD\n"), ("b.txt", "longer\n"), ("a.txt", "A\n")] {
        std::fs::write(root.as_path().join(name), body).unwrap();
    }
    let ctx = context_seeded(&root, Arc::new(LocalFileService::new()), Vec::new()).await;
    let tool = ListTool::new();
    let (error, first) = text_of(tool.call(&ctx, json!({"limit": 1})).await);
    assert!(!error, "{first}");
    assert_eq!(first, "a.txt\tfile\n[entries 1-1 of 4; offset:1 for more]");

    let (error, late) = text_of(tool.call(&ctx, json!({"limit": 1, "offset": 2})).await);
    assert!(!error, "{late}");
    assert_eq!(late, "c.txt\tfile\n[entries 3-3 of 4; offset:3 for more]");

    let (error, detailed) = text_of(tool.call(&ctx, json!({"limit": 1, "offset": 2, "meta": true})).await);
    assert!(!error, "{detailed}");
    let (row, continuation) = detailed.split_once('\n').unwrap();
    let cols: Vec<_> = row.split('\t').collect();
    assert_eq!((&cols[..3], cols.last()), (&["c.txt", "file", "4"][..], Some(&"2")));
    assert_eq!(continuation, "[entries 3-3 of 4; offset:3 for more]");
}

#[tokio::test]
async fn list_pages_a_global_size_ranking_before_rendering() {
    let (_dir, root) = small_dir();
    for (name, body) in [("a.txt", "a"), ("b.txt", "bbb"), ("c.txt", "cc"), ("d.txt", "ddd")] {
        std::fs::write(root.as_path().join(name), body).unwrap();
    }
    let ctx = context_seeded(&root, Arc::new(LocalFileService::new()), Vec::new()).await;
    let tool = ListTool::new();
    let (error, page) = text_of(tool.call(&ctx, json!({"sort": "size", "offset": 1, "limit": 2})).await);
    assert!(!error, "{page}");
    assert_eq!(page, "d.txt\tfile\nc.txt\tfile\n[entries 2-3 of 4; offset:3 for more]");

    let (error, page) = text_of(tool.call(&ctx, json!({"mode": "find", "name": "*.txt", "sort": "size", "offset": 1, "limit": 2})).await);
    assert!(!error, "{page}");
    let mut lines = page.lines();
    assert_eq!(lines.next().and_then(|line| line.split('\t').next()), Some("d.txt"));
    assert_eq!(lines.next().and_then(|line| line.split('\t').next()), Some("c.txt"));
    assert_eq!(lines.next(), Some("[entries 2-3 of 4; offset:3 for more]"));
    assert_eq!(lines.next(), None);
}

#[tokio::test]
async fn a_recursive_glob_pages_the_whole_matching_scope() {
    let (_dir, root) = small_dir();
    for (name, seconds) in [
        ("src/a/tie.ts", 1),
        ("src/z/tie.ts", 1),
        ("src/z/new.ts", 2),
        ("src/z/new.js", 3),
        ("src/node_modules/pkg/noise.ts", 3),
        ("outside/new.ts", 3),
    ] {
        let path = root.as_path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = std::fs::File::create(path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000 + seconds)).unwrap();
    }
    let ctx = context_seeded(&root, Arc::new(LocalFileService::new()), Vec::new()).await;
    let tool = GlobTool::new();
    for (sort, offset, expected) in [
        ("mtime", 0, "src/z/new.ts\n[entries 1-1 of 3; offset:1 for more]"),
        ("mtime", 1, "src/a/tie.ts\n[entries 2-2 of 3; offset:2 for more]"),
        ("mtime", 2, "src/z/tie.ts"),
        ("natural", 1, "src/z/new.ts\n[entries 2-2 of 3; offset:2 for more]"),
    ] {
        let (error, text) = text_of(tool.call(&ctx, json!({"path": "src", "pattern": "**/*.ts", "sort": sort, "offset": offset, "limit": 1})).await);
        assert!(!error, "{text}");
        assert_eq!(text, expected);
    }
}

#[tokio::test]
async fn stat_only_list_does_not_read_the_selected_file() {
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("a.txt"), "one\ntwo\n").unwrap();
    let io = Arc::new(StatControl::record_locator_io());
    let service = Arc::new(StatFails(Arc::new(LocalFileService::new()), &[], &[], io.clone()));
    let ctx = context_seeded(&root, service, Vec::new()).await;
    let list = ListTool::new();
    let (error, stat) = text_of(list.call(&ctx, json!({"meta": false, "stat_only": true})).await);
    assert!(!error, "{stat}");
    assert!(stat.starts_with("a.txt\tfile\t8\t"), "{stat}");
    assert_eq!(stat.split('\t').count(), 5, "{stat}");
    assert!(io.reads.as_ref().unwrap().lock().unwrap().is_empty());

    let (error, full) = text_of(list.call(&ctx, json!({"meta": true})).await);
    assert!(!error, "{full}");
    assert_eq!(full, format!("{stat}\t2"));
    assert_eq!(*io.reads.as_ref().unwrap().lock().unwrap(), [root.join("a.txt")]);
}

#[tokio::test]
async fn natural_glob_skips_candidate_stats_but_mtime_pages_keep_failed_stats_last() {
    let (_dir, root) = small_dir();
    for name in ["a-failed.txt", "b-failed.txt", "z-good.txt"] {
        std::fs::write(root.as_path().join(name), "").unwrap();
    }
    let mut io = StatControl::record_locator_io();
    io.repeated_walk_entry = Some(DirEntry { path: root.join("a-failed.txt"), kind: EntryKind::File });
    let io = Arc::new(io);
    let service = Arc::new(StatFails(Arc::new(LocalFileService::new()), &["a-failed.txt", "b-failed.txt"], &[], io.clone()));
    let ctx = context_seeded(&root, service, Vec::new()).await;
    let glob = GlobTool::new();
    let (error, natural) = text_of(glob.call(&ctx, json!({"pattern": "*.txt", "limit": 1, "sort": "natural"})).await);
    assert!(!error, "{natural}");
    assert_eq!(natural, "a-failed.txt\n[entries 1-1 of 3; offset:1 for more]");
    let stats = io.stats.as_ref().unwrap();
    assert!(stats.lock().unwrap().iter().all(|path| path == &root));
    stats.lock().unwrap().clear();

    let newest = glob.call(&ctx, json!({"pattern": "*.txt", "limit": 1})).await.unwrap();
    assert_eq!(newest.meta.as_ref().unwrap()["complete"], json!(false));
    assert_eq!(text_of(Ok(newest)).1, "z-good.txt\n[entries 1-1 of 3; offset:1 for more]");
    let mut candidates: Vec<_> = stats.lock().unwrap().iter().filter(|path| *path != &root).cloned().collect();
    candidates.sort_unstable();
    assert_eq!(candidates, [root.join("a-failed.txt"), root.join("b-failed.txt"), root.join("z-good.txt")]);

    let (error, late) = text_of(glob.call(&ctx, json!({"pattern": "*.txt", "limit": 1, "offset": 2})).await);
    assert!(!error, "{late}");
    assert_eq!(late, "b-failed.txt");
}
