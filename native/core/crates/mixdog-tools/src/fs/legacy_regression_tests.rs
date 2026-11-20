//! Behaviours of the Node v1.4.5 file tools that the Rust tools had lost.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the tests build and inspect real work trees with blocking filesystem calls")]

use mixdog_core_api::domain::tool::Tool;

use super::tests::context_seeded;
use super::tests::small_dir;
use super::tests::text_of;
use super::*;

fn files(names: &[&str]) -> Vec<(String, Vec<u8>)> {
    names.iter().map(|name| ((*name).to_owned(), b"needle\n".to_vec())).collect()
}

fn local() -> std::sync::Arc<dyn mixdog_core_api::domain::fs::FileService> {
    std::sync::Arc::new(mixdog_workspace::localfs::LocalFileService::new())
}

fn lines(text: &str) -> Vec<&str> {
    text.lines().collect()
}

/// `globBaseEntry`: a `path` naming a set of directories walks from its static base with the wildcard folded into the pattern.
#[tokio::test]
async fn glob_takes_a_wildcard_directory_scope() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, local(), files(&["packages/a/src/x.ts", "packages/b/src/y.ts", "packages/b/lib/z.ts"])).await;
    let (error, text) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.ts", "path": "packages/*/src", "sort": "natural" })).await);
    assert!(!error, "{text}");
    assert_eq!(lines(&text), ["packages/a/src/x.ts", "packages/b/src/y.ts"]);
}

/// rg's later glob wins: a positive glob after a negative one re-includes what the negative excluded.
#[tokio::test]
async fn a_later_positive_glob_reincludes_after_a_negative() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, local(), files(&["a.js", "generated-x.js", "generated-keep.js"])).await;
    let (error, text) =
        text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": ["*.js", "!generated*.js", "generated-keep.js"], "sort": "natural" })).await);
    assert!(!error, "{text}");
    assert_eq!(lines(&text), ["a.js", "generated-keep.js"]);
}

/// The legacy spellings: glob's `root`, grep's `output_mode` and `head_limit`.
#[tokio::test]
async fn legacy_root_output_mode_and_head_limit_are_read() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, local(), files(&["sub/a.txt", "sub/b.txt", "top.txt"])).await;
    let (_, by_root) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.txt", "root": "sub", "sort": "natural" })).await);
    assert_eq!(lines(&by_root), ["sub/a.txt", "sub/b.txt"]);
    let (_, one) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.txt", "head_limit": 1, "sort": "natural" })).await);
    assert!(lines(&one).first().is_some_and(|first| first.ends_with(".txt")) && one.contains("[entries 1-1 of"), "{one}");
    let grep = GrepTool::new();
    let (_, legacy) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "output_mode": "count" })).await);
    let (_, compact) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "mode": "count" })).await);
    assert_eq!(legacy, compact);
    assert!(!legacy.contains("needle"), "{legacy}");
    let (_, limited) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "output_mode": "files_with_matches", "head_limit": 1 })).await);
    let (_, compact_limited) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "mode": "files", "limit": 1 })).await);
    assert_eq!(limited, compact_limited);
}

/// `normalizeInputPath` expands a `~` pattern; on POSIX a backslash stays a glob escape.
#[test]
fn glob_patterns_expand_home_and_keep_posix_escapes() {
    let patterns = super::search::glob_patterns(&serde_json::json!({ "pattern": ["~/x/*.rs", "a\\*b"] }));
    if let Some(home) = super::read_paths::home_dir() {
        assert!(patterns[0].starts_with(&home.replace('\\', "/")) || patterns[0].starts_with(&home), "{patterns:?}");
    }
    assert_eq!(patterns[1], if cfg!(windows) { "a/*b" } else { "a\\*b" });
}

/// `fuzzyFindRequest`: `hidden:false` skips dot-directories and `depth` bounds the walk.
#[tokio::test]
async fn find_honours_hidden_and_depth() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, local(), files(&["file_zz.txt", ".hid/file_zz.txt", "a/b/file_zz.txt"])).await;
    let find = FindTool::new();
    let (_, all) = text_of(find.call(&ctx, serde_json::json!({ "query": "file_zz" })).await);
    assert!(all.contains(".hid/file_zz.txt") && all.contains("a/b/file_zz.txt"), "{all}");
    let (_, visible) = text_of(find.call(&ctx, serde_json::json!({ "query": "file_zz", "hidden": false })).await);
    assert!(!visible.contains(".hid") && visible.contains("a/b/file_zz.txt"), "{visible}");
    let (_, shallow) = text_of(find.call(&ctx, serde_json::json!({ "query": "file_zz", "depth": 1 })).await);
    assert!(shallow.contains("file_zz.txt") && !shallow.contains("a/b/"), "{shallow}");
}

/// `_*DefaultHeadLimit`: the positive integer `parseInt` reads from the override, else the stock default.
#[test]
fn the_default_head_limit_overrides_are_read_as_parse_int() {
    let name = "MIXDOG_TEST_DEFAULT_HEAD_LIMIT";
    for (value, want) in [("7", 7), (" 12abc", 12), ("0", 100), ("-3", 100), ("abc", 100), ("", 100)] {
        // SAFETY: a variable no other test reads.
        unsafe { std::env::set_var(name, value) };
        assert_eq!(common::env_default_limit(name, 100), want, "{value:?}");
    }
    unsafe { std::env::remove_var(name) };
    assert_eq!(common::env_default_limit(name, 100), 100);
}

/// `list` reports a symlink row by its own `lstat`: the link's size, not the target's.
#[cfg(unix)]
#[tokio::test]
async fn list_meta_reports_a_symlink_by_its_own_metadata() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, local(), vec![("big.txt".to_owned(), vec![b'x'; 5000])]).await;
    std::os::unix::fs::symlink("big.txt", root.as_path().join("ln")).unwrap();
    let (error, text) = text_of(ListTool::new().call(&ctx, serde_json::json!({ "meta": true })).await);
    assert!(!error, "{text}");
    let row = text.lines().find(|line| line.starts_with("ln\t")).expect("the link row");
    let fields: Vec<&str> = row.split('\t').collect();
    assert_eq!(fields[2], "7", "{row}");
    assert_eq!(fields.len(), 5, "no line count is read through a link: {row}");
}

/// Issue #339: a folder holding only noise is not read as empty, and a listing says how many noise entries it left out.
#[tokio::test]
async fn list_counts_the_noise_entries_it_excluded() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, local(), files(&["only_noise/__pycache__/m.pyc", "mixed/__pycache__/m.pyc", "mixed/keep.txt"])).await;
    std::fs::create_dir(root.as_path().join("truly_empty")).unwrap();
    let list = ListTool::new();
    let (_, noise_only) = text_of(list.call(&ctx, serde_json::json!({ "path": "only_noise" })).await);
    assert!(noise_only.contains("1 noise entries excluded (include_noise:true to show)") && !noise_only.contains("(empty directory)"), "{noise_only}");
    let (_, empty) = text_of(list.call(&ctx, serde_json::json!({ "path": "truly_empty" })).await);
    assert!(empty.starts_with("(no entries match filter)") && !empty.contains("noise"), "{empty}");
    let (_, mixed) = text_of(list.call(&ctx, serde_json::json!({ "path": "mixed" })).await);
    assert_eq!(lines(&mixed), ["keep.txt\tfile", "1 noise entries excluded (include_noise:true to show)"]);
    let (_, shown) = text_of(list.call(&ctx, serde_json::json!({ "path": "only_noise", "include_noise": true })).await);
    assert_eq!(shown, "__pycache__\tdir");
}

/// The cache dependency roots of a glob are the roots the call walks: a wildcard `path` is its static base, a glob
/// written as the path is searched from the cwd.
#[test]
fn glob_result_roots_split_a_wildcard_scope() {
    let roots = |args: serde_json::Value| super::search::glob_result_roots(&args).unwrap();
    assert_eq!(roots(serde_json::json!({ "pattern": "*.ts", "path": "packages/*/src" })), ["packages"]);
    assert_eq!(roots(serde_json::json!({ "path": "src/**/*.ts" })), ["."]);
    assert_eq!(roots(serde_json::json!({ "pattern": "*.ts", "root": "sub" })), ["sub"]);
}

/// `normalizeInputPath` reaches a separate `path` (`~` expanded); a UNC or device `path` stays a path to be refused.
#[test]
fn glob_scope_expands_home_and_keeps_a_unc_path_a_path() {
    let (path, patterns) = super::search::glob_scope(Some("~/src"), vec!["*.rs".to_owned()]);
    if let Some(home) = super::read_paths::home_dir() {
        assert!(!path.starts_with('~') && path.contains("src") && path.len() > "src".len(), "{path} {home}");
    }
    assert_eq!(patterns, ["*.rs"]);
    let (path, patterns) = super::search::glob_scope(Some("\\\\?\\C:\\x"), Vec::new());
    assert_eq!(path, "\\\\?\\C:\\x");
    assert!(patterns.is_empty());
}

/// A numeric-string `head_limit` is its number; a bare `output_mode:"content"` is not clamped to 40 blocks.
#[tokio::test]
async fn head_limit_strings_are_coerced_and_bare_content_is_not_clamped() {
    let (_dir, root) = small_dir();
    let many = "needle\n".repeat(60).into_bytes();
    let ctx = context_seeded(&root, local(), vec![("a.txt".to_owned(), many), ("b.txt".to_owned(), b"needle\n".to_vec())]).await;
    let grep = GrepTool::new();
    let (_, one) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "output_mode": "files_with_matches", "head_limit": "1" })).await);
    assert_eq!(one.lines().take_while(|l| l.ends_with(".txt")).count(), 1, "{one}");
    let (_, bare) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "path": "a.txt", "output_mode": "content", "head_limit": 100 })).await);
    assert_eq!(bare.matches("needle").count(), 60, "{bare}");
    let (_, clamped) =
        text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "path": "a.txt", "output_mode": "content_with_context", "head_limit": 100 })).await);
    assert!(clamped.matches("needle").count() <= 40 * 21, "{clamped}");
    assert_ne!(clamped, bare);
}

/// A file named as the path is the one file searched (ripgrep's file operand): not the files of that name below its
/// folder, and no folder beside it is walked to find it.
#[tokio::test]
async fn a_file_named_as_the_path_is_the_only_file_searched() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(
        &root,
        local(),
        vec![
            ("package.json".to_owned(), b"needle top\n".to_vec()),
            ("sub/package.json".to_owned(), b"needle below\n".to_vec()),
            ("sub/deep/package.json".to_owned(), b"needle deep\n".to_vec()),
            ("README.md".to_owned(), b"needle beside\n".to_vec()),
            ("sub/notes.md".to_owned(), b"needle notes\n".to_vec()),
        ],
    )
    .await;
    let grep = GrepTool::new();
    // An include glob confines nothing beside the file and opens no sibling: matched by the file or not, the file alone is
    // searched, as without the glob.
    for glob in ["*.md", "*.json", "**/*.md"] {
        for mode in ["content", "files_with_matches", "count"] {
            let (_, text) =
                text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "path": "package.json", "glob": glob, "output_mode": mode })).await);
            assert!(!text.contains("sub") && !text.contains("README"), "{glob} {mode}: {text}");
        }
        let (_, text) =
            text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "path": "package.json", "glob": glob, "output_mode": "content" })).await);
        assert!(text.contains("needle top") && text.matches("needle").count() == 1, "{glob}: {text}");
    }
    for mode in ["content", "files_with_matches", "count"] {
        let (_, text) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "path": "package.json", "output_mode": mode })).await);
        assert!(!text.contains("sub"), "{mode}: {text}");
    }
    let (_, text) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "path": "package.json", "output_mode": "content" })).await);
    assert_eq!(text.matches("needle").count(), 1, "{text}");
    assert!(text.contains("needle top"), "{text}");
    let (_, below) = text_of(grep.call(&ctx, serde_json::json!({ "pattern": "needle", "path": "sub/package.json", "output_mode": "content" })).await);
    assert!(below.contains("needle below") && !below.contains("deep"), "{below}");
}

/// `fuzzyFindRequest` reads `depth` with radix-10 `parseInt`; a tree of only noise says so.
#[tokio::test]
async fn find_depth_is_parse_int_and_a_noise_only_tree_is_not_empty() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, local(), files(&["file_zz.txt", "a/b/file_zz.txt", "only_noise/__pycache__/m.pyc"])).await;
    let find = FindTool::new();
    for depth in [serde_json::json!("1e2"), serde_json::json!("1levels")] {
        let (_, text) = text_of(find.call(&ctx, serde_json::json!({ "query": "file_zz", "depth": depth })).await);
        assert!(text.contains("file_zz.txt") && !text.contains("a/b/"), "{text}");
    }
    let (_, deep) = text_of(find.call(&ctx, serde_json::json!({ "query": "file_zz", "depth": "3x" })).await);
    assert!(deep.contains("a/b/file_zz.txt"), "{deep}");
    let (_, tree) = text_of(ListTool::new().call(&ctx, serde_json::json!({ "mode": "tree", "path": "only_noise" })).await);
    assert!(tree.contains("1 noise entries excluded (include_noise:true to show)"), "{tree}");
}
