//! The plugin declaration digest cache and the push-based skills watcher on real directories.
#![allow(clippy::disallowed_methods, reason = "test fixtures write and inspect directories directly")]

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use mixdog_mcp::declaration_cache::DeclarationCache;
use mixdog_mcp::plugins::PluginMcpDeclarations;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_rt::LaneToken;
use mixdog_workspace::watcher::FolderWatcher;
use tokio_util::sync::CancellationToken;

async fn load(cache: &Arc<DeclarationCache>, root: &Path) -> PluginMcpDeclarations {
    let tokens = mixdog_rt::testing::tokens();
    let (cache, root) = (Arc::clone(cache), root.to_path_buf());
    tokens
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| cache.load(lane, &root))
        .unwrap()
        .await
        .unwrap()
}

#[tokio::test]
async fn unchanged_files_serve_the_cache_and_any_edit_rereads() {
    let dir = tempfile::tempdir().unwrap();
    let mcp = dir.path().join(".mcp.json");
    std::fs::write(&mcp, r#"{"mcpServers":{"a":{"command":"x"}}}"#).unwrap();
    let cache = Arc::new(DeclarationCache::new());
    let first = load(&cache, dir.path()).await;
    assert_eq!(first.servers.len(), 1);
    assert_eq!(load(&cache, dir.path()).await, first);
    std::fs::write(&mcp, r#"{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}"#).unwrap();
    assert_eq!(load(&cache, dir.path()).await.servers.len(), 2);
    std::fs::remove_file(&mcp).unwrap();
    assert!(load(&cache, dir.path()).await.servers.is_empty());
}

#[tokio::test]
async fn a_file_the_manifest_points_at_appearing_later_invalidates() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("plugin.json"), r#"{"name":"p","mcpServers":"servers.json"}"#).unwrap();
    let cache = Arc::new(DeclarationCache::new());
    assert_eq!(load(&cache, dir.path()).await.errors.len(), 1);
    std::fs::write(dir.path().join("servers.json"), r#"{"s":{"command":"x"}}"#).unwrap();
    let after = load(&cache, dir.path()).await;
    assert!(after.errors.is_empty() && after.servers.len() == 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_skill_written_under_a_watched_root_pushes_a_change() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let skills = SkillsWatch::new();
    let watcher = Arc::new(FolderWatcher::new(skills.sink()).unwrap());
    skills.attach(Arc::clone(&watcher));
    skills.set_roots(std::slice::from_ref(&root));
    let mut changes = skills.subscribe();
    std::fs::create_dir_all(root.join("alpha")).unwrap();
    std::fs::write(root.join("alpha").join("SKILL.md"), "---\nname: alpha\n---\n").unwrap();
    tokio::time::timeout(Duration::from_secs(10), changes.changed())
        .await
        .expect("the change is pushed")
        .unwrap();
    assert!(*changes.borrow() > 0);
}
